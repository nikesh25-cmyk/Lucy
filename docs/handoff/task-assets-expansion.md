# Task — expand the CC0 asset pool (character-first)

Branch **`task-assets-expansion`**, worktree `work/w2-assets`.
Base commit **`1de1de3`** (*Merge DeepSeek master wave into reviewed NemoWorld source*), advanced by a
fast-forward to **`50c6fe8`** (*Add a licence-verified CC0 asset pool and integrate sampled audio*)
before any change here. This slice is **one commit on top of `50c6fe8`**, subject *Grow the asset pool
with character art, audio, materials, HDRIs, UI, icons and fonts*; the commit hash is deliberately not
quoted here, because it is the commit this file ships in — take it from `git log -1` or from the patch
subject. See §0.
**Schema is unchanged: 23.** No migration, no table, column, index, trigger or view; no new dependency
(`playwright-core` stays the only devDependency); no file outside `scripts/fetch-asset-pool.mjs` and
`asset-pool/**` was touched.

## 0. Why the branch starts at the sibling commit

`asset-pool/` and `scripts/fetch-asset-pool.mjs` do not exist at `1de1de3`; they are the deliverable of
the parallel task **`task-asset-pool`** (worktree `w-assets`, branch `task-asset-pool`), whose tip
`50c6fe8` is a **direct descendant of `1de1de3`**. This slice is defined as *growing* that pool, so the
first step was `git merge --ff-only task-asset-pool` — a fast-forward, no merge commit, no conflict, and
nothing authored by this task in `server.js`, `app.js`, `src/**`, `tests/**`. This slice's own commit is
a single commit on top of `50c6fe8`, and this patch (`git format-patch -1`) applies cleanly on
`50c6fe8` and only there. If the integration path merges `task-asset-pool` separately, merge this branch
after it; if this branch is taken alone, it brings the base pool with it.

## 1. Goal

Grow `asset-pool/` into a much larger, more varied, strictly-licensed library, in the order the slice
set out: **(a) 2D character art**, (b) audio — music loops, ambient beds, footsteps on more surfaces,
more UI and world SFX, jingles, (c) more 1K PBR materials and 1K HDRIs, (d) UI kits, SVG icon sets and
OFL fonts. Only `CC0-1.0`, `OFL-1.1`, `ISC`, `MIT` and `CC-BY-3.0/4.0`; nothing else is downloaded and
nothing is kept whose terms cannot be named. Every downloaded **and** every extracted file of interest
is recorded with its source URL, home page, author, licence, notice text, byte size and SHA-256.

## 2. Changed files

| File | Change |
| --- | --- |
| `scripts/fetch-asset-pool.mjs` | Rewritten: 108-item catalogue (was 26), per-artefact licence verification, archive extraction, per-extracted-file rights index, per-run download budget, `--list`, and a `--verify` that cross-checks the whole catalogue. |
| `asset-pool/manifest.json` | Regenerated: 108 items, per item the source URL, home page, author, licence, notice text + `notice_sha256`, the artefact's byte size and SHA-256, where the notice was read from, and the pinned commit/tag where one exists. |
| `asset-pool/index.json` | **New, now committed** (was git-ignored): every extracted file of interest — 45,580 records of `{path, ext, bytes, sha256}` — grouped inside the rights record of the archive it came from. |
| `asset-pool/NOTICES.md` | Regenerated: the human register, by category, naming the author and where each notice was read from. |
| `asset-pool/POOL.md` | Rewritten: the expanded pool, the character-first reasoning, the budget semantics, the rights process and the honest limits. |
| `asset-pool/.gitignore` | `index.json` removed from the ignore list, so the per-file rights record is part of the deliverable; `files/` and `extracted/` stay ignored (large, reproducible). |

Nothing else. `git status` on this tree shows exactly those six paths and no others.

## 3. What the pool now holds

108 items (26 before, 82 added). Sizes are the archives the manifest hashes; "files" counts extracted
files of interest.

| Category | Items | Files | Archives | Licence | Sources |
| --- | --- | --- | --- | --- | --- |
| `character` | 39 | 18,596 | 49.35 MB | CC0-1.0 | kenney.nl, opengameart.org |
| `texture` | 14 | 106 | 84.97 MB | CC0-1.0 | ambientcg.com |
| `audio` | 14 | 1,284 | 43.43 MB | CC0-1.0 | kenney.nl, opengameart.org |
| `hdri` | 14 | 14 | 20.48 MB | CC0-1.0 | polyhaven.com |
| `ui` | 14 | 13,931 | 15.23 MB | CC0-1.0 | kenney.nl |
| `icons` | 5 | 7,998 | 8.24 MB | CC0-1.0, CC-BY-3.0, MIT | kenney.nl, game-icons.net, heroicons |
| `font` | 7 | 36 | 2.72 MB | CC0-1.0, OFL-1.1 | kenney.nl, google/fonts |
| `model-staged` | 1 | 3,615 | 10.05 MB | CC0-1.0 | kenney.nl (staged only; the pinned renderer has no mesh loader) |

**Licence list across all 108 items: `CC0-1.0` ×100, `OFL-1.1` ×6, `MIT` ×1, `CC-BY-3.0` ×1.**
Totals: **234.46 MB** of archives, **45,580** extracted files of interest (**299.95 MB**).
Against the base pool (26 items, 92.97 MB archives, 9,982 useful extracted files), that is
**+82 items, +141.5 MB of archives, +35,598 recorded files.**

Priority (a) — character art — is 39 of the 82 new items: 31 CC0 Kenney packs (sprite sheets and walk
cycles, avatar and body parts, `emotes-pack` faces, and three rigged pre-animated 3D character kits) and
8 CC0 OpenGameArt packs, including both Dungeon Crawl Stone Soup sheets (9,049 sprites), the ninja
adventure pack with its facesets, Sunny Land, Hero Spritesheets and Zelda-like sprites. Priority (b) —
audio — adds 4 Kenney packs (two of them voice-over), the 512-clip retro SFX collection with its
footsteps folder, a loop-ready chiptune pack and two ambient beds.
(c) adds 5 ambientCG 1K material sets and 8 Poly Haven 1K HDRIs. (d) adds 13 Kenney UI/icon packs, the
4,239-icon CC BY 3.0 `game-icons.net` set, the 2,580-icon MIT Heroicons set and six OFL font families
(Cinzel, EB Garamond, Inter, IBM Plex Sans, JetBrains Mono, Lora) from `google/fonts` at the pinned
commit `e9678a5385322c63730122ba464765baad83cfd8`, each with its own `OFL.txt`.

## 4. What was tested, and the evidence

### The gate commands (run in this worktree, Node v24.15.0 per `.nvmrc`)

```
$ npm run check
> node scripts/check-syntax.mjs
checked 94 files, 0 failed                                    # exit 0

$ npm test
> node --test
ℹ tests 993   ℹ pass 993   ℹ fail 0
ℹ cancelled 0  ℹ skipped 0  ℹ todo 0
ℹ duration_ms 408232.492542                                   # exit 0

$ npm run e2e
> node scripts/e2e-smoke.mjs
SUMMARY  20 steps passed, 0 failed
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API
                                                              # exit 0
```

**One flake, reported both ways as instructed.** `npm test` was run three times on this tree. The first
and third runs were **993 pass / 0 fail (exit 0)**. The second run was **992 pass / 1 fail (exit 1)**, the
failure being `tests/realtime-latency.test.js:43` *"measured update latency and frame rate on the loopback
fixture"* with `AssertionError: every fixture client must be subscribed — 0 !== 16`, alongside
`read ECONNRESET` noise from activity after the test ended. The machine was saturated throughout by the
other agents in this wave (load average **28–55**, two `scripts/browser-suite.mjs` Chrome runs and a
second `server.js` live), and the fixture needs sixteen SSE subscribers to connect inside a bound.
Re-run focused: six back-to-back runs gave **1 pass / 5 fail** with partial subscriptions (1, 3, 7, 9 and
15 of 16) during the loudest minutes, then **three consecutive passes** as the load eased. The failure is
environmental, not a regression, and it cannot be this slice's: the commit touches seven paths — the
fetcher, five files under `asset-pool/` and this handoff — and that test loads `server.js`, not one of
them. Nothing was loosened, no timeout was raised, and no skipped test was reported as a pass.

`npm run browser` was **not** run, because nothing in this change is browser-visible: no route, no
stylesheet, no renderer and no served asset changed, and `asset-pool/` is not served by `server.js`
(see §5.9). The suite baseline is unchanged at 993 tests; this slice adds no test file of its own, as the
pool's evidence is the fetcher's own `--verify` rather than a unit test over 45,580 vendored bytes.

### `node scripts/fetch-asset-pool.mjs --max-mb 150` — the fetch pass

First pass, real output (abridged tail):

```
downloaded 138.77 MB this run; the pool now holds 107 items and 231.48 MB of archives
extracted 43569 files of interest, 297.10 MB
licences: CC0-1.0×99, CC-BY-3.0×1, MIT×1, OFL-1.1×6
1 skipped
  skip kenney-crosshair-pack: unzip failed: checkdir error: cannot create …
```

That one skip was a real defect this task then fixed: `kenney-crosshair-pack` stores `×` in a folder
name in a legacy encoding, and Info-ZIP refuses to create any name that is not valid UTF-8. The
extractor now retries such an archive with `bsdtar` rather than dropping an otherwise CC0 pack, and it
excludes `__MACOSX/` resource forks from the index. The re-run that fixed it downloaded **0.00 MB**
(the archive was already on disk and hash-recorded) and reported:

```
downloaded 0.00 MB this run; the pool now holds 108 items and 234.46 MB of archives
extracted 45580 files of interest, 299.95 MB
licences: CC0-1.0×100, CC-BY-3.0×1, MIT×1, OFL-1.1×6
  audio          14 items    1284 files     43.43 MB
  character      39 items   18596 files     49.35 MB
  font            7 items      36 files      2.72 MB
  hdri           14 items      14 files     20.48 MB
  icons           5 items    7998 files      8.24 MB
  model-staged    1 items    3615 files     10.05 MB
  texture        14 items     106 files     84.97 MB
  ui             14 items   13931 files     15.23 MB
```

### `node scripts/fetch-asset-pool.mjs --verify` — the final pass

```
verified 108 items, 234.46 MB, 45580 extracted files; 0 unavailable, 0 mismatched
```

Exit status **0**. `--verify` re-hashes every archive against `manifest.json` and every extracted file
against `index.json`, writes nothing, and additionally fails if any catalogue item is neither on disk
nor recorded as skipped — so a silently dropped item cannot pass. The record it verified is the one this
commit carries:

```
65e62064…  was the record before the licence-file match was broadened
1f317cc29fcb486723aff4fa0afd5c4a398d996c5ce2fc9e8030729489c401ff  asset-pool/manifest.json
2944d46227748c024825191589a47c5739a3d515ef157db6cff4958af9da2cc2  asset-pool/index.json
b0c734bf1f83eb5d71ca29772a3be0bff2796e696a22e80fa0681393188d7946  asset-pool/NOTICES.md
```

### Assertions proved by runs, not by reading

| Assertion | How it was proved | Result |
| --- | --- | --- |
| Re-running fetches nothing | second full run printed `downloaded 0.00 MB this run` | 0.00 MB, archives unchanged |
| A category-filtered run does not shrink the record | `--only font` (7 items in scope) against a 108-item pool | exit 0; `manifest.json`, `index.json` and `NOTICES.md` were **byte-identical** to the full run's (SHA-256 `65e62064…`, `1a12afe8…`, `b0c734bf…`) |
| The record is deterministic | the same hashes reproduced across three independent full runs and a filtered run | identical |
| The download budget refuses rather than silently truncating | moved `kenney-casino-audio.zip` aside, ran `--only audio --max-mb 0` | exit 1, `107 items`, skip recorded: *"needs 0.84 MB and only 0.00 MB of the 0 MB per-run budget is left"* |
| Every licence-named file inside an archive is inspected | broadened the licence-file match to `public-license.txt` and re-ran | `opengameart-sunny-land-2d-pixel-art-pack` now records `licence_conflict: "Sunny-land-assets-files/public-license.txt"` — the pack's own notice says "Public domain and free to use", which does not name CC0, so the licence was verified from the OpenGameArt submission page instead (which does), and the difference is recorded rather than hidden |
| The pool returns to exactly its recorded state | restored the archive, re-ran | the same three SHA-256 values again |
| Archival extraction is deterministic | the same 45,580 file hashes held across four extractions | identical |

There is **no database assertion in this slice**: it changes no schema, no table and no query. Nothing
here needs a disposable database. Nothing was reported as a skipped test as a pass.

## 5. Residual limits (honest)

1. **Nothing is integrated, and nothing 3D or HDRI can be.** The pool is raw material. 3D meshes and
   HDRIs stay *staged*, because `docs/ASSET_LIBRARY.md` records that the pinned Three.js bundle ships
   no `GLTFLoader`, `OBJLoader` or `TextureLoader` and that re-bundling it was already rejected.
2. **Character art is not wired into the renderer.** The shipped character is still the project-authored
   cube resident (`src/characters.js`). Wiring a sprite path is a renderer change this slice does not own.
3. **The pool is ~673 MB on disk** (`files/` 237 MB, `extracted/` 424 MB and the 12.3 MB committed
   record). All of it except the three record files is git-ignored and reproducible from them. It is
   under the ~20 GB free-disk constraint but is not small; `--max-mb` bounds downloads, not the unpacked
   tree, so a machine short of disk should fetch with a smaller `--max-mb` and extract only what it
   needs.
4. **`index.json` is 12.2 MB of committed JSON** (45,580 file records). That is a deliberate trade-off:
   it is the only way a reader can check an individual extracted file against the committed record
   without re-fetching, and the requirement names SHA-256 for every extracted file. The alternative —
   leaving it git-ignored as the base pool did — would make the per-file record reproducible but not
   reviewable. If the repo would rather not carry it, delete the file and re-add it to
   `asset-pool/.gitignore`; `--verify` then reports the index as unavailable rather than mismatched.
5. **Licence verification is of the artefact and the publisher's page, not of every file inside every
   pack.** Every archive is checked for every file in it whose *name* declares it a licence (nested ones
   included), and every extracted file carries a hash; an archive whose own notice file does not name the
   declared licence falls back to the rights holder's page and the disagreement is recorded in
   `licence_conflict` rather than hidden. Exactly one item sets it today:
   `opengameart-sunny-land-2d-pixel-art-pack`, whose bundled `public-license.txt` says "Public domain and
   free to use" while its OpenGameArt submission declares CC0 1.0 — the CC0 declaration is the one
   recorded, from the page. A licence stated only in an image or an `.url` file would still be missed.
6. **One catalogue item was refused by name before it was ever downloaded.** `ambientcg-Bricks075` in
   the base catalogue does not exist at ambientCG; the base fetcher swallowed the 404 into a skip and
   still reported 10 materials. This catalogue names only IDs verified against the ambientCG API, and
   `--verify` now fails if any catalogue item is neither on disk nor recorded as skipped.
7. **Two OpenGameArt pages hand out a single file rather than an archive** (`dungeon-ambience`,
   `crystal-cave-song18`); the fetcher handles them as one-file items, so their "extracted" count is 1.
8. **The pinned artefact URLs can rot.** Each is recorded with its SHA-256, and a fetch that returns
   different bytes would be recorded as different bytes rather than silently accepted; re-pinning is a
   one-line change per item. Kenney's media URLs are content-addressed and stable so far.
9. **`npm run browser` was not run**, because nothing in this change is browser-visible: no route, no
   stylesheet, no renderer, no served asset changed. `asset-pool/` is not served by `server.js`.
10. **No dedicated portrait/faceset pack was added.** The slice's priority (a) named "sprite sheets,
    portrait/faceset packs, character animation sheets, clothing/avatar parts". Sheets, animation sets
    and clothing/avatar parts are all in — `modular-characters` ships separate `Skin`/`Face`/`Hair`/
    `Shirts`/`Pants`/`Shoes` part folders, DENZI's `paperdoll` holds a male and a female doll split into
    head/torso/arms/legs/hands/feet, and `ninja-adventure-free-sprite` is ten animations exported frame
    by frame. Faces exist as parts, emote icons and frames, but **no CC0 pack whose headline role is a
    portrait or faceset was added**, because the ones found in this pass were either CC BY-SA (the LPC
    family, which is not on the allowlist) or already vendored as the twenty mayor appearances in
    `assets/mayors/`. A future pass should look specifically for that one gap.

## 6. Migration and rollback

- **Migration: none.** No schema change, no data migration, no runtime change. The pool is additive
  content plus one rewrite of a build-time script.
- **Rollback:** revert the single commit (`git revert <sha>`, or reset to `50c6fe8`). To drop only the
  new material, delete `asset-pool/files/` and `asset-pool/extracted/` and run
  `node scripts/fetch-asset-pool.mjs --only <categories>`; the record rewrites itself, and
  `--verify` fails while the record names something that is no longer on disk. To remove the pool
  entirely, restore `scripts/fetch-asset-pool.mjs` and `asset-pool/**` from `1de1de3` — nothing else in
  the repository reads either.
- **Nothing is pushed, published, installed or sold.** No external message was sent. No database,
  backup, credential, model weight or `outputs/Lucy` file was read or written.
