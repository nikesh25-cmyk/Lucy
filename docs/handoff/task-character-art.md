# Task — higher-quality 2D character art in the interface

Branch **`task-character-art`**, worktree `w2-art`, base **`1de1de3`** (*Merge DeepSeek master wave
into reviewed NemoWorld source*). No schema change, no migration, no new dependency and no new API
route; the only served paths added are static entries in the server's file map.

**Goal.** Give residents a better face in the DOM layers — the profile, the resident roster, the
mayor/ambassador views and the first-play guide. Two CC0 art sets were sourced, staged under `assets/`
with a per-file licence and provenance record, and wired into the interface with alt text. The only
change to `server.js` is inside the static `files` map (a distinct region from the runtime's API route
table), and it is a written-out allow-list of fixed strings.

## Changed files

| File | What it is |
| --- | --- |
| `assets/residents/faces/01.png`–`27.png` | **New.** 27 CC0 portrait busts, 32 × 32, cropped from one sheet |
| `assets/residents/bodies/01.png`–`10.png` | **New.** 10 CC0 standing figures, 16 × 16, copied byte for byte |
| `assets/residents/manifest.json` | **New.** Per file: source pack, source path, SHA-256, bytes, pixel size, crop rectangle |
| `assets/residents/NOTICE.md` | **New.** The same record in prose: authors, source URLs, licences, notices, the crop grid, the mapping rule |
| `assets/residents/licenses/kenney-tiny-dungeon-License.txt` | **New.** The pack's own notice, retained verbatim |
| `assets/THIRD_PARTY.md` | A "Resident art" section with the two packs, their digests and their licences |
| `tests/resident-art.test.js` | **New.** 6 tests: manifest integrity, every served path, alt-text bounds, sizes, weight |
| `app.js` | The resident-art block and the seven call sites it replaces |
| `game-theme.css` | `.resident-face`, `.resident-figure`, the passport and guide layouts, the phone sizes |
| `server.js` | **Two lines inside the static `files` map**: `/assets/residents/faces/{01..27}.png` and `/assets/residents/bodies/{01..10}.png` |
| `docs/GAME_INTERFACE.md` | A "Resident art in the interface" section |
| `docs/ASSET_LIBRARY.md` | An "Interface resident art" section, with the non-claims it keeps |
| `docs/handoff/task-character-art.md` | **New.** This file |

Untouched, deliberately: `src/**`, `runtime/**`, `native/**`, `content/**`, `index.html`,
`game-mobile.css`, `assets/manifest.json`, `assets/mayors/**`, `package.json`, `scripts/**`,
`.github/**`, `outputs/**`.

**Ownership note on `server.js`.** A parallel agent owns the runtime and the API route table in this
same wave, so the change here is deliberately confined: it is two `files.set(...)` lines in the static
file-map region (the `const files = new Map([...])` block and the `files.set` lines that follow it,
immediately after the existing civic-mayor sprite line and well before `const writes = new Map([...])`).
`gets`, `writes` and the request dispatch are untouched, so there is nothing in this change for another
owner of the route table to conflict with, and nothing here is derived from a URL.

## The art, and where it came from

| Set | Files | Art | Author | Licence | Source |
| --- | --- | --- | --- | --- | --- |
| `faces/` | 27 | 32 × 32 | Buch | `CC0-1.0` | OpenGameArt, ["RPG portraits"](https://opengameart.org/content/rpg-portraits), sheet SHA-256 `234ccba32fcc80dbea00e6257dc29127d0e2e0f89f0336eb5c1ff691bacc4ff1` |
| `bodies/` | 10 | 16 × 16 | Kenney | `CC0-1.0` | [kenney.nl, "Tiny Dungeon"](https://kenney.nl/assets/tiny-dungeon), archive SHA-256 `c109438ab06f65fd80f9b2686a4cf9c7c11dc64444b47333ec71d602f8bb5fc7` |

- The face set is **derived**: each staged file is one 32 × 32 cell of a 328 × 112 sheet (cell 32 × 32,
  origin (4, 4), stride 36 px), cropped without resampling or recolouring. The source digest, the crop
  grid and each file's own SHA-256 are in the manifest, and `tests/resident-art.test.js` checks that the
  grid yields exactly as many cells as there are staged faces and that the last crop stays inside the
  source sheet.
- The figure set is **verbatim**: the pack's `Tiles/tile_0084`–`tile_0088` and `tile_0096`–`tile_0100`,
  the ten person tiles. No furniture, weapon, potion or monster tile was staged.
- Both authors are credited although CC0 does not require it: Buch asked to be credited as Buch, and
  Kenney asks only that users consider it.
- **"From the pool".** The slice asked for the art to come from the asset pool. The pool
  (`asset-pool/`, branch `task-asset-pool`) is not present in this worktree and, on inspection of the
  copy in the sibling `w-assets` worktree, holds no portrait or character art: its `ui` items are Kenney
  UI shapes and Lucide-style icons, its textures are ambientCG material sets, and the only person-like
  names among its extracted PNGs are the `multiplayer` / `singleplayer` UI glyphs — nothing that is a
  face or a standing character. Rather than invent a pool entry, the two packs were fetched from their
  own publishers, verified against the licence each publisher ships, and recorded in the pool's own shape
  (per file: URL, author, licence, notice, bytes, SHA-256). Staging them as `assets/**` — which this
  slice does own — keeps the record with the art. If the pool later adds character packs, these files
  should be reconciled with them rather than re-fetched.

## How the interface uses it

One place in `app.js` builds a face and one builds a figure, and every layer calls them:

| Layer | Change |
| --- | --- |
| Profile — the resident passport | `agentMark` → the resident's figure plus a 64 px face, in a new `.passport-portrait` row |
| Resident roster — the world's people list, the civic rosters, the character picker records | `agentMark` → a 32 px face |
| "Participating as …" line, world arrival row | `agentMark` → a 32 px face |
| Mayor and ambassador views | The ambassador's own sealed CC0 portrait still rides `/assets/mayors/facesets/`; the resident rows around it now carry faces |
| First-play guide | `decorateFirstPlayEncounter()` prepends the encounter's figure and face to the card the guide module already marks `data-guide="encounter"` |

**Which art a resident gets is arithmetic on its stored id** (`residentIdHash`, the project's own
FNV-1a fold, the same idiom `src/characters.js` uses for skin tones): `id % 27 + 1` for the face and
`hash('figure:' + id) % 10 + 1` for the figure. The same resident therefore shows the same art in every
layer and every session, with no stored preference and no request. A resident that carries a sealed
appearance sprite keeps that sealed portrait instead, and a resident with no id keeps the coloured
emblem rather than a face that would change between two polls. The five sealed agent colours tint the
frame when the server published one of them; no other value can reach the style attribute.

**Alt text** is built in one function from the same strict allow-list the nameplates use (`name`,
`kind`): *"Aliya, AI resident portrait"*, *"…, AI resident appearance"*, *"…, human player portrait"*.
An unnamed resident is announced as "Resident", and a name is truncated at 40 characters. Paths are
served by fixed strings in `server.js`, so a path is never derived from a request.

## What was tested

`tests/resident-art.test.js`, 6 tests, all passing:

1. **`every staged resident art file matches its recorded licence and provenance`** — 2 source packs,
   both `CC0-1.0` with the CC0 deed URL; every source records author, home, file URL, digest, bytes,
   notice and modification; 37 staged files, none listed twice; each file is a PNG whose SHA-256, byte
   size and pixel size match the manifest; a face crops a 32 px cell inside the sheet and a figure is
   copied whole; the recorded 9 × 3 grid yields exactly the 27 staged faces; the last crop stays inside
   328 × 112; `assets/residents/faces` and `bodies` on disk list exactly what the manifest lists;
   `NOTICE.md` credits both authors.
2. **`the licence notice the pack shipped is retained and hashed`** — the retained Kenney `License.txt`
   matches its recorded digest and still says *Creative Commons Zero, CC0*.
3. **`every face and figure path the interface can build is served by the static map`** — the counts
   `app.js` declares equals the staged counts; **all 37 paths are fetched over real HTTP** and return
   `200`, `image/png` and a PNG header; `/assets/mayors/facesets/16.png` still serves the ambassador's
   sealed portrait; `faces/28.png`, `faces/00.png`, `bodies/11.png`, `faces/01.PNG`,
   `manifest.json` and a path that leaves the set all `404`; a `POST` to a served path is `405`.
4. **`the interface draws resident art with bounded alt text and no private payload field`** — one face
   renderer and one figure renderer; both set `alt` from the shared builder; the builder reads
   `resident?.name` and `resident?.kind` and contains no reference to operator, capabilities,
   limitations, bio or email; the face path uses the sealed sprite when present and the id hash
   otherwise; the hash reads the id string and folds with `Math.imul`; all seven call sites and the
   guide decoration are present.
5. **`the art direction the set is placed in keeps its two whole-number sizes`** — 32 px and 64 px faces,
   64 px figures, `box-sizing:content-box`, `image-rendering:pixelated`; the phone sizes are whole
   multiples (32 px, 48 px); `game-mobile.css` still contains no `resident-` selector, so the touch
   stylesheet's `.nm-touch`-only contract is intact.
6. **`the staged set stays small enough to serve from the page it appears on`** — 37 files, under
   300 KiB in total.

No database assertion is made by this slice: it adds no table, column, route or stored value, and no
resident's stored art preference exists to assert. The server was started against the ordinary
`tests/helpers.js` fixture (a disposable database) purely to fetch the 37 static paths over HTTP.

## Gate output (real)

Run on this tree, 14 October 2026, on a machine shared with the other wave-2 agents.

```
$ npm run check
checked 92 files, 0 failed

$ node --test
# tests 995
# suites 0
# pass 995
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 695066.473958
```

The six new tests are `ok 766`–`ok 771` in that run. The whole suite was re-run after the last change to
the interface (`app.js`, `game-theme.css`, `server.js`); the only edits after that run are comment lines
in the new test file and text in this handoff. No test was skipped, none was weakened, and no timeout was
raised.

```
$ npm run e2e
SUMMARY  20 steps passed, 0 failed
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API
```

```
$ npm run browser          # real Chrome 155.0.8059.40, 45 scenarios
SUMMARY  38 passed, 7 failed
  result  FAIL — see the failing scenario above
```

All seven failures were Playwright action timeouts, not assertions, and the suite recorded the machine
as `load average 44.6/86.4/132.7 at the end of the run` (the load average peaked near 207 during the
window; two other browser suites from other worktrees were running at the same time):

| Scenario | Failure | Where it timed out |
| --- | --- | --- |
| `refresh-and-focus-restoration` | `page.reload: Timeout 25000ms exceeded` | navigation to `/?mode=workspace` |
| `cooperative-restoration-two-operators` | `locator.click: Timeout 25000ms exceeded` | `#view summary` detached from the DOM, retried |
| `live-observation-readonly` | `locator.click: Timeout 25000ms exceeded` | the `Observe` button |
| `game-shell-entry-and-continue` | `page.goto: Timeout 25000ms exceeded` | `/` |
| `management-interface-and-roles` | `locator.click: Timeout 25000ms exceeded` | `#game-menu-button` never visible |
| `first-ten-minutes` | `page.reload: Timeout 25000ms exceeded` | `/` |
| `first-play-solo-ambassador` | `page.reload: Timeout 25000ms exceeded` | `/` |

Re-run focused, at a load average near 34, exactly those seven scenarios, and nothing else:

```
$ LUCY_BROWSER_ONLY=refresh-and-focus-restoration,cooperative-restoration-two-operators,live-observation-readonly,game-shell-entry-and-continue,management-interface-and-roles,first-ten-minutes,first-play-solo-ambassador npm run browser
SUMMARY  7 passed, 0 failed
  PASS  refresh-and-focus-restoration (12191 ms)
  PASS  cooperative-restoration-two-operators (48954 ms)
  PASS  live-observation-readonly (6120 ms)
  PASS  game-shell-entry-and-continue (21754 ms)
  PASS  management-interface-and-roles (22788 ms)
  PASS  first-ten-minutes (121061 ms)
  PASS  first-play-solo-ambassador (33184 ms)
  result  PASS — the interface was driven in a real browser and the database agreed
```

Both results are reported as they happened. In the full run, 38 of 45 scenarios passed on the first
attempt; the seven that did not were re-run focused and all seven passed, including the two guide
scenarios this slice decorates (`first-ten-minutes`, `first-play-solo-ambassador`) and the passport and
roster scenarios (`management-interface-and-roles`, `game-shell-entry-and-continue`). No scenario failed
twice, and no scenario in either run reported an assertion failure rather than a timeout.

## Evidence: every new file, its licence and its SHA-256

Both sets are `CC0-1.0`. The digest below is of the staged file itself, so it changes if the file ever
does; the manifest holds the same values plus the source URL, author, notice and crop rectangle for
each one, and the source sheets and archives with their own digests. Total staged size **98,857 bytes**.

| Staged file | Licence | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `faces/01.png` | CC0-1.0 | 3523 | `d33025883578d42716c2964bc67bcc7cd0f3591d12ae1e393a212b7a42acfbda` |
| `faces/02.png` | CC0-1.0 | 3520 | `40a0a031e08563155059d7ae171cfefc0b40d19d9b4864123f83450d35a382ff` |
| `faces/03.png` | CC0-1.0 | 3907 | `aca584856bb43c6fa924056ad6e5a7da76423888864c724781766de57c02411b` |
| `faces/04.png` | CC0-1.0 | 3500 | `5262b293767fb2c0976afe34e16d952fa4c29f812d6851a69b8443296905b6e7` |
| `faces/05.png` | CC0-1.0 | 3485 | `a7f89b307400ee8d2331371ac543549d55efa3fb211acc99e195f8c909a6faf8` |
| `faces/06.png` | CC0-1.0 | 3540 | `1772850b2fddc2afe5a239ac7c26ccd9c7a7052ae7eb27b0ff7e22bc12a1a742` |
| `faces/07.png` | CC0-1.0 | 3450 | `afb540fbf7adfb3bcaace24a081cd1f373896f8155c272df76281527a2c9acf3` |
| `faces/08.png` | CC0-1.0 | 3520 | `585aa9f1db223c7fca1dcce8fc153d2dcffa46aa3a0cefa81705ef4ba0241fe1` |
| `faces/09.png` | CC0-1.0 | 3768 | `4c43065e23632b28b3eb5e3b40a6966f10007d15cd9e0f2e6c321db3ca5e90f7` |
| `faces/10.png` | CC0-1.0 | 3504 | `6603e45f8cf8ebf65bc19ab77c28ce5ed0faec1adcddd8a882f39463ed375a82` |
| `faces/11.png` | CC0-1.0 | 3506 | `1c25c49bf38a57e21ea4b18505d8ff7129b8cb7c55dedcbb685db5838a25da68` |
| `faces/12.png` | CC0-1.0 | 3860 | `3830443f202462e3bc22ba696a607cc21c7b215430f1ebef355dd118a2a07611` |
| `faces/13.png` | CC0-1.0 | 3413 | `756f7bd5aa5af3a38c19f722b5c8e24d37d344187ab8af7263272f28a59b3f8d` |
| `faces/14.png` | CC0-1.0 | 3484 | `23a0d2026474d2d2f9255ae6cedcf8924ad458d95c1b17d72d3cf70bec02d461` |
| `faces/15.png` | CC0-1.0 | 3538 | `3f2364210fc9dd1cabb6b11794ed8d35408f5ffc06c3c45f6369be767d688fcc` |
| `faces/16.png` | CC0-1.0 | 3588 | `9bee4fd8a80edf487ffe1a1a2a979caa62271ef7a8707e6bdbdf449842488f7b` |
| `faces/17.png` | CC0-1.0 | 3363 | `8392f4d0cf6a08317f5e760c942ac5e9fa9a20726bb350b2007e9d8715047d56` |
| `faces/18.png` | CC0-1.0 | 3836 | `05a4ef96fab7f8f6bc1bc56191fc0ca448a03c9c96510d43cd58e22335543de7` |
| `faces/19.png` | CC0-1.0 | 3505 | `83294e3bdcf25314a6b803d550329b41f3df7259947c8c81c6f10326133fceca` |
| `faces/20.png` | CC0-1.0 | 3512 | `63cd619c343f1e4f2ea2e433759f6cbdb61674bf93cc68b062e28e27341a4295` |
| `faces/21.png` | CC0-1.0 | 3884 | `671c78d2dd7a75faa9d5e2f340991e9156e042f27ee3cc4898c68bb45b74f9d7` |
| `faces/22.png` | CC0-1.0 | 3475 | `fa964850c6a63a240723b5ee284bcc03f8638165bec329ba6e6668d2d833fe5c` |
| `faces/23.png` | CC0-1.0 | 3476 | `7f39b5a1b837bbd085df132537b051fab106a1c43bf6e5dd8c8416ea6f561e77` |
| `faces/24.png` | CC0-1.0 | 3584 | `620fa59d9b6981a5db148516bebc77148ad9e24cca12963fe4176b26e623869a` |
| `faces/25.png` | CC0-1.0 | 3532 | `f24f4c40223c39b1d910c567fa59d2cec2a82d0265a7dd4bd30c55fd79943186` |
| `faces/26.png` | CC0-1.0 | 3485 | `cf975f4f1df3d482d1ef2a295a99cc29f8b266c1044612e0d1bbddca0970de42` |
| `faces/27.png` | CC0-1.0 | 3805 | `780bbc8ecda74b6dc8bc451a8281e1c9d7245e4d72f56b0e3b8877c5e8e6f3b3` |
| `bodies/01.png` | CC0-1.0 | 232 | `b3909f80a29a0f18729f96a90ebe446ecaf26a195da633f2a6c3dd31f660821e` |
| `bodies/02.png` | CC0-1.0 | 230 | `377b35acbce5129e8167df1f5d1d0420805990962a37a30f5784b88b81a40ec2` |
| `bodies/03.png` | CC0-1.0 | 224 | `0606653ad07e177c06c9782c9fff4b1388c7b67865b6ab0e202f76e8e6f6bec8` |
| `bodies/04.png` | CC0-1.0 | 239 | `321ecd683c4e542e09d368709e75821b8b823b7b98b71bebb39d66cead951315` |
| `bodies/05.png` | CC0-1.0 | 222 | `ad6715e9bcab60faed303260a21adfca2de09a7950b98384065bcc5df05634b2` |
| `bodies/06.png` | CC0-1.0 | 206 | `b8a0a9376c1c3398a059a1e3226e8f8d6839c1d73ac53ea37425340d762055fd` |
| `bodies/07.png` | CC0-1.0 | 225 | `20915fde756b990f5b0c86fda557a93a6c306373d7c4fc07a1991f4ace3271b4` |
| `bodies/08.png` | CC0-1.0 | 238 | `39b7c35f414e086b9c7e0cd2b34693ae370e5382a05b4dbb9964cef20f9769c8` |
| `bodies/09.png` | CC0-1.0 | 238 | `61af4b9f1f67aa761e89e516ac6d60371175875b78b073b7f6a8415517c66181` |
| `bodies/10.png` | CC0-1.0 | 240 | `e139ab1d56c599af1cea5a955b705ead18a92d41e8e635b550729383cad9de3c` |

Sources, in the same order the manifest records them:

| Pack | Licence | Author | Source | Digest |
| --- | --- | --- | --- | --- |
| RPG portraits (27 faces) | `CC0-1.0` | Buch | `https://opengameart.org/content/rpg-portraits` · sheet `https://opengameart.org/sites/default/files/rpgportraits.png` | `234ccba32fcc80dbea00e6257dc29127d0e2e0f89f0336eb5c1ff691bacc4ff1` (21,125 bytes, 328 × 112) |
| Tiny Dungeon (10 figures) | `CC0-1.0` | Kenney (kenney.nl) | `https://kenney.nl/assets/tiny-dungeon` · archive `.../kenney_tiny-dungeon.zip` | `c109438ab06f65fd80f9b2686a4cf9c7c11dc64444b47333ec71d602f8bb5fc7` (98,530 bytes) |
| Retained notice | `CC0-1.0` | Kenney | `assets/residents/licenses/kenney-tiny-dungeon-License.txt` | `9f574a2f1f636a3db8a0665ba90212f34e2b5e61ecb533d77c05237766374111` |

## Evidence: the art in a real browser

`npm run browser` drives the shipped shell but asserts on the world's own records, not on a portrait, so
the rendering was checked separately in the same system Chrome build (155.0.8059.40) against the
shipped server and a disposable database: sign in through the real dialog, open **My characters**, then
**Resident passport**, and read the DOM back.

```
character picker: 1 face image(s)
  /assets/residents/faces/19.png · alt "Verifier, AI resident portrait" · decoded 32px · drawn 32px · pixelated
passport: 2 image(s)
  /assets/residents/bodies/03.png · alt "Verifier, AI resident appearance" · decoded 16px · drawn 64px
  /assets/residents/faces/19.png · alt "Verifier, AI resident portrait" · decoded 32px · drawn 64px
passport heading: A story still being written
resident art responses after a reload: 1
PASS — the resident art renders and decodes in Chrome
```

Each run created a fresh resident, so the face number differs between runs while staying stable for that
id: it is a function of the id, not of the name. The face decodes at its own 32 px and is drawn at 32 px
in a list and 64 px on the passport; the figure decodes at 16 px and is drawn at 64 px; both report
`image-rendering: pixelated`; and the alt text names the resident and its role. The script that took this
reading was a one-off in `/tmp` and is not part of the repository; the checks it performs are the ones
`tests/resident-art.test.js` asserts statically, plus Chrome's own decode.

## Residual limits

- **The mapping is arbitrary by design.** A resident's face is a hash, not a resemblance: an operator
  cannot choose it, and a resident whose id changes would change face. Nothing in the payload is
  consulted beyond the id and, for an ambassador, the sealed sprite, because inventing a "portrait
  selection" from a name or capability would be a client-authored world fact.
- **27 faces for a roster of hundreds.** Ambassadors keep their own sealed portraits, but two plain
  residents will share a face. The set is small because no CC0 pack with more portraits could be
  verified for this wave; the pool has no portrait art at all.
- **Two authors, two art sizes.** The faces (Buch, 32 × 32) and figures (Kenney, 16 × 16) are different
  releases. Both are pixel art at the world's own scale and both are CC0, but they are not one pack, and
  a face and a figure for the same resident are not drawn by the same artist.
- **The face set is derived art.** The crop is lossless and pinned, and the source digest is recorded,
  but the staged files are crops of a third-party sheet, so their digests cannot be found upstream.
- **No pixel-level visual review beyond the rendered pages.** The faces, the 64 px figure and the 32 px
  list face were opened in Chrome and looked at (the passport card renders the figure beside the face,
  framed by the resident's own agent colour), but the contrast of the art against both the light
  workspace and the dark game shell was checked by eye, not measured, and no automated visual
  regression baseline exists.
- **The first-play decoration is a DOM insertion and is not asserted.** The guide module renders text
  only and owns the card; the shell prepends art to the card it marks `data-guide="encounter"`. If that
  attribute were renamed the decoration would silently stop rather than fail: the browser scenarios that
  exercise the guide (`first-ten-minutes`, `first-play-solo-ambassador`) render it and pass, but they
  assert on the server's own rows, not on the portrait, and the DOM check above opened the passport and
  the roster rather than the guide.
- **`assets/residents/manifest.json` is not served.** The record lives in the repository and in
  `NOTICE.md`; a browser cannot fetch it, and no route was added for it.
- **The art adds 37 same-origin image requests to a page**, 98,857 bytes in total (about 97 KiB),
  revalidated on each navigation because the static map sends `Cache-Control: no-cache`. That is small
  beside the world's own payload, but it is not zero, and it was not measured as a separate cost.

## Migration and rollback

No migration: no schema version, table, column, index, route or content definition changes, and the
database is untouched. Rollback is a revert of this branch's commits — the 42 new files (40 under
`assets/residents/`, `tests/resident-art.test.js` and this handoff) are additive, and the edits to
`app.js`, `game-theme.css`, `server.js`, `assets/THIRD_PARTY.md`, `docs/GAME_INTERFACE.md` and
`docs/ASSET_LIBRARY.md` are self-contained. After a revert the interface returns to the coloured emblem
(`agentMark`), which is still in `app.js` as the no-id fallback.
