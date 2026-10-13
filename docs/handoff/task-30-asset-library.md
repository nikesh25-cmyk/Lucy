# Task 30 handoff — unified asset library

Branch `task-30-asset-library`, worktree `work/t30`, based on `feat/nemoworld-game-first` at
`d59b69194524e9573456f7bcf274234a2d5be380` ("Make NemoWorld a game-first shared experience").
Written 2026-10-13.

## Deliverables

| File | What it is |
| --- | --- |
| `docs/ASSET_LIBRARY.md` | The selection: the family chosen, the evidence for it, the units an implementer places against, the coherence argument, verified versus specified, unresolved rights, non-claims |
| `docs/assets/asset-manifest.json` | Machine-readable manifest, schema version 1: **51 selected entries** (terrain 9, architecture 9, vegetation 9, furniture 16, characters 4, ui_icons 4), each with id, category, status, source URL and path, package/version, licence, attribution notice, modification permission, format, measured dimensions/polycount, download size, **scale, orientation, collision footprint, intended use** and unresolved rights; plus **13 verified-but-unselected candidates** and **15 unresolved-rights register entries**. A `field_notes` block defines all 15 fields so the file is self-describing; `counts_by_status` (45 produced / 2 vendored / 4 specified) and `blocked_candidate_count` (13) make the totals checkable |
| `docs/assets/ATTRIBUTION.md` | Attribution register: the licence and the exact notice text required by every selected entry, including the project-authored ones (`LicenseRef-NemoWorld-Project-Authored`) and the notice text a future selection of the blocked candidates would need |
| `docs/assets/contact-sheet.html` | Self-contained local contact sheet, 51 original inline SVG/CSS cards with id, category and licence status, four labelled `NOT PRODUCED` placeholders, and a table of the blocked candidates and the unresolved rights. No network request, no external font, no image, no script, no new dependency |
| `docs/handoff/task-30-asset-library.md` | This brief |

Nothing under `assets/`, `src/`, `content/`, `app.js`, `index.html`, `style.css` or
`nemo-theme.css` was read-modified or written. `docs/GAME_EXPERIENCE.md` and `docs/specs/**` (a
parallel task) were not touched.

## The family chosen, and the evidence for it

**"The NemoWorld Commons set": original project-authored, flat-shaded 1 m cube geometry, plus the two
third-party art sets already vendored in this repository whose code paths already work (the CC0 mayor
sprite sheets and the ISC Lucide icon set). No third-party 3D mesh pack is selected.**

Decided by evidence, not preference:

1. **The pinned renderer has no model loader.** Re-measured here on 2026-10-13: importing
   `assets/vendor/three-voxel.js` yields exactly **27 exports** and no `GLTFLoader`, `OBJLoader` or
   `TextureLoader`. The file is 551,333 bytes, SHA-256
   `37fe9184bb0c982e1d48e77375fbeb6b2f8a3fdd54b62a5f0cd87499fdcb5e88`, matching
   `assets/vendor/three-source-manifest.json`.
2. **No licensed pack is a drop-in.** Every 3D candidate in `docs/research/ASSET_SHORTLIST.json`
   records integration cost *High* for that reason, and none is grid-aligned (organic low-poly, modern
   suburban, rigged humanoids, hex tiles on a square grid).
3. **Re-bundling was already rejected** by the engine decision record (`docs/VOXEL_ENGINE_REUSE.md`,
   cited in `docs/research/ASSET_SHORTLIST.md` §What a selection would still require, point 2), so a
   loader is an engineering decision that no asset download settles.
4. **Per-file terms inside every pack archive are unread**, because reading them requires the download
   this task forbids.
5. **The sealed content layer already answers the question this way**: every block, furniture, crop and
   cosmetic definition is `LicenseRef-NemoWorld-Project-Authored` with `appearance.geometry: "cube"` or
   a builder name in `src/voxel-world.js` (`content/THIRD_PARTY.md`).
6. **The two vendored sets work through existing paths**: Lucide SVGs are served as files and tinted in
   CSS (`server.js:71`, `app.js:507`, `nemo-theme.css:11`); the CC0 mayor sheets load through the 2D
   canvas atlas route and are sealed as `content/appearances/*.json`.

## What is verified, and what is only specified

**Measured, not estimated.** Every polycount in the manifest was obtained by importing
`src/voxel-world.js` and reading `createVoxelScene().update().stats` with one scenery object in a
uniform 37 × 37 window. Results: 1–13 boxes per item (12–156 triangles); a resident is 12 boxes; a
terrain cell 2 boxes, water 3.26, a bridge 6, a wall 3, a building tile 4, a garden cell 6; a full
window measures 2,750 boxes on plain land and 8,230 boxes (98,760 triangles) in the worst measured
case, against limits of 1,369 cells, 260 objects, 2,048 blocks, 220 participants and 8 layers.

**Produced (45 entries)** — geometry exists and draws today in `src/voxel-world.js` or `world.js`.

**Vendored third party (2 entries)** — both were already in the repository before this task; no file
was added to `assets/`:
- `char.mayor-sprite-sheet`: 20 appearances, CC0 1.0, Pixel-boy / Sparklin Labs, commit
  `e8674a03ab4456802f71f848c4df79eccca23f7a`, notice `assets/mayors/LICENSE.txt`.
- `ui.nav-icon-set`: 15 SVGs, ISC, Lucide `lucide-static` 1.55.0; four of them (`chevron-right`,
  `compass`, `log-in`, `x`) are Feather-derived under MIT, both notices in `assets/icons/LICENSE.txt`.

**Specified with nothing produced (4 entries)**, each found by reading the code and each marked as a
labelled placeholder in the contact sheet that states exactly what is missing:

| Entry | Gap found in the code |
| --- | --- |
| `arch.civic-hall` | `house()` branches only on `"shelter"`, so the sealed `civic-building` type draws the cottage branch (measured: 8 boxes, identical material set). The sealed definition's own note describes a "large 2.5 × 2 building" the code does not draw. |
| `arch.canopy-arch` | The frame vocabulary is `gateway`/`shelter`/`portal`/`gate`; there is no overhead arch over a garden path and `veg.trellis` is a `mass` two-post panel. |
| `veg.hedge-row` | None of the 27 sealed furniture entries is a hedge, so a garden parcel has no low continuous green mass. |
| `ui.asset-library-glyph` | The 15 vendored icons include no library/catalogue glyph; nothing in the shell links to an asset library screen. |

## Unresolved rights

Full detail in `docs/assets/asset-manifest.json` → `unresolved_rights` (15 entries, each with a
severity, subject, detail and action). The decisive ones:

1. **There is no root LICENSE** in the repository and `package.json` is `private` with no licence
   field, so **49 of the 51 selected entries have no stated redistribution terms**. `docs/assets/ATTRIBUTION.md`
   states this plainly and records the required notice text for project work as "terms are unstated".
   This is an owner decision; this task does not attempt to resolve it.
2. The renderer's missing loader blocks every mesh pack.
3. The `License.txt` inside every Kenney and KayKit archive remains unread (no download).
4. **Terasology PlantPack has no asset-level licence at all** — the one candidate of the 25 flagged
   unverified. Study only; do not integrate.
5. Quaternius QAL v1.0 §3a redistribution ambiguity — do not integrate without clarification.
6. Luanti `minetest_game` media CC BY-SA 3.0 share-alike with an unenumerated exception list.
7. Three observed inconsistencies in files this task does not own, reported not fixed:
   `content/furniture/civic-building.json` (note describes geometry the renderer does not draw),
   `content/furniture/pond.json` (note says there is no pond builder; the branch exists at
   `src/voxel-world.js:128` and a measured pond draws that branch's `#4b9dad`), and
   `nemo-theme.css:45` (frontier swatches are unasserted hand-picked tints; wood draws `#b58c58` but is
   swatched `#a78354`).

## Limitations and non-claims

- **Nothing is integrated.** No asset was downloaded, extracted, converted or imported; no file under
  `assets/` was added or replaced; no renderer, server route, CSP rule or stylesheet changed. Task 38
  owns the UI wiring and this task does not pre-empt it.
- **No browser check of the game was performed or claimed.** The contact sheet HTML was opened once
  against a throwaway local static server to confirm that this document renders as intended — a check
  of the document, not of the world, the renderer or any asset. The server and tab were closed again.
- **No new research.** Every licence statement traces to the 2026-10-12 verification in
  `docs/research/ASSET_SHORTLIST.json` and the URLs it already records.
- Audio, rigged animation, textures and high-resolution imagery are outside the family and are not
  claimed as solved. Three verified audio candidates are carried forward as blocked candidates only.
- Polycounts and download sizes for third-party packs remain unknown; only the family's own items carry
  a measured polycount.
- The contact sheet is a document, not a QA artifact: not a screenshot, not a render, and not evidence
  that any geometry draws correctly in a browser.
- Three of the four specifications would need a **content re-seal**, a separate reviewed step this task
  deliberately did not take.

## Checks run in this worktree

Node v24.19.0, npm 10.9.8, with `work/node-bin` prepended to `PATH`.

- **`npm run check` — passed, exit 0** (the 31-file `node --check` list, no output).
- **`npm test` — passed: 565 tests, 565 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo**, duration
  60,806 ms (60.81 s) on the final tree. An earlier run of the same tree measured 53,975 ms (53.98 s),
  so the suite duration varies a few seconds between runs. The change adds Markdown, JSON and one
  self-contained HTML document only, so nothing under test is affected; `npm test` does not read
  `docs/`.
- `npm run e2e` and `npm run browser` were **not** run and are not claimed: this is a
  documentation-only change, and running the browser suite would be a claim about the game that this
  task explicitly does not make.
- The contact sheet was generated from `asset-manifest.json` by a throwaway script that was **not
  committed**, so the sheet and the manifest are consistent by construction; the script was deleted so
  the deliverable contains exactly the four files listed above. Its card count (51), placeholder count
  (4) and absence of any external/network reference were verified by reading the generated file.

## Follow-ups for the next task

1. **Answer the root-licence question.** Until it is answered, 49 entries have no redistribution terms.
2. **Decide the geometry question** (renderer loader versus continued authored cube geometry) before
   any mesh pack is reconsidered; `docs/research/ASSET_SHORTLIST.md` point 2 records the trade-off.
3. **If the family is ever integrated**, place items with the manifest's own `scale`, `orientation` and
   `collision_footprint` fields rather than re-deriving them, and re-read and hash each pack's archive
   licence at download time as `assets/mayors/manifest.json` already does.
4. **Re-seal `content/`** if any specification (`arch.civic-hall`, `arch.canopy-arch`, `veg.hedge-row`)
   is taken forward; that is a separate reviewed step.
5. The two stale content notes and the unasserted hotbar swatch colours are cheap fixes owned by other
   tasks (`content/` and `nemo-theme.css`).
