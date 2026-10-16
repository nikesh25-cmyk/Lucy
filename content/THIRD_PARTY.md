# Typed content definitions: per-entry license and provenance notices

This directory holds the versioned, typed content definitions for NemoWorld blocks, furniture,
crops, NPC appearances and cosmetics. Every definition carries **its own** license record. This
notice file exists so that a reader never has to infer an asset's terms from a repository-wide
statement, and so that no asset can silently inherit a licence it was never released under.
It implements recommendation 3 of [the voxel engine reuse decision](../docs/VOXEL_ENGINE_REUSE.md):
"give blocks, furniture, crops and NPC appearances versioned schemas and individual license
manifests. A repository-wide license must not substitute for inspecting a particular asset's terms."

Written 12 October 2026. Nothing here is legal advice; it records what could and could not be
verified from the files actually present in this repository.

## There is no repository-wide licence

The repository contains no `LICENSE`, `COPYING` or `LICENCE` file, and `package.json` declares
`"private": true` with no `license` field. There is therefore **no** repository-wide licence that a
consumer could rely on, and none is implied here. Definitions written for this project are recorded
with a locally defined SPDX `LicenseRef` rather than an invented standard identifier:

| SPDX identifier | Meaning recorded for these entries |
| --- | --- |
| `LicenseRef-NemoWorld-Project-Authored` | Original work written for this project. No third-party asset was copied, traced, decompiled or translated to produce it. The repository grants no distribution licence today, so redistribution terms are unstated and must be obtained from the project owner. |
| `CC0-1.0` | The asset is released under CC0 1.0 Universal by its author. |

`LicenseRef-NemoWorld-Project-Authored` is deliberately **not** `MIT`, not the Three.js licence,
not the SIL Open Font License of the bundled fonts and not the ISC/MIT notice of the bundled
Lucide icons. Those terms cover other files in this repository and must not be stretched to cover
these definitions. Use of an unrelated permissive licence as a stand-in is exactly the failure
mode this layer is meant to prevent.

## What each group is, and why it carries the licence it does

| Group | Entries | Recorded licence | Author | Why |
| --- | --- | --- | --- | --- |
| `blocks/` | 7 | `LicenseRef-NemoWorld-Project-Authored` | NemoWorld project contributors | Cube geometry is drawn by this project's own code (`src/voxel-world.js`), and the two colour tables are project-authored literals (`src/voxel-world.js` `COLORS`, `world.js` `FRONTIER_BLOCK_COLORS`). No Minecraft, Luanti, Terasology or other engine asset, block model or texture is used. |
| `furniture/` | 27 | `LicenseRef-NemoWorld-Project-Authored` | NemoWorld project contributors | Every builder named in `rules.geometry` is a block-out routine already implemented in `src/voxel-world.js` (and, for the tile renderer, `world.js`). The geometry is original project code; no third-party model, sprite or mesh is included. |
| `crops/` | 3 | `LicenseRef-NemoWorld-Project-Authored` | NemoWorld project contributors | Growth times, yields and limits are original project game data from `src/journey.js`. The tile they are planted on is the project-authored `farm` furniture entry. No crop art is bundled. |
| `appearances/` | 20 | `CC0-1.0` | Pixel-boy / Sparklin Labs | The only third-party **art** in this layer. Character sheets and portrait facesets are used verbatim from a CC0 pack; the pinned commit, per-file checksums, notice file and notice hash are recorded on every entry. |
| `cosmetics/` | 29 | `LicenseRef-NemoWorld-Project-Authored` | NemoWorld project contributors | Titles, keepsake names, crafted decorations, character colour names, skin tones and expressions are project data. They bundle no image, font or icon file. |

Counts are asserted by `tests/content.test.js`, which recomputes them from the definitions rather
than trusting this table.

## Third-party art: the civic mayor sprites

The 20 civic mayor appearances are the CC0 Ninja Adventure character sheets and facesets retained in
[`assets/mayors/`](../assets/mayors/):

| Fact | Recorded value |
| --- | --- |
| Licence | `CC0-1.0` (CC0 1.0 Universal) |
| Author | Pixel-boy / Sparklin Labs |
| Source repository | `https://github.com/sparklinlabs/superpowers-asset-packs` |
| Pinned commit | `e8674a03ab4456802f71f848c4df79eccca23f7a` (from `assets/mayors/manifest.json`, the same commit cited in `docs/OPEN_SOURCE.md`) |
| Notice file | [`assets/mayors/LICENSE.txt`](../assets/mayors/LICENSE.txt), SHA-256 `36ffd9dc085d529a7e60e1276d73ae5a030b020313e6c5408593a6ae2af39673` |
| Pack manifest | [`assets/mayors/manifest.json`](../assets/mayors/manifest.json) |

CC0 waives copyright in the artwork. It does **not** cover this project's own wiring: the roster
selection, the `/assets/mayors/characters/{n}.png` and `/assets/mayors/facesets/{n}.png` routes, the
frame layout mapping and the placement code are original project work recorded separately.

The pack's portrait files are retained twice: in the pack's own layout at
`characters/faceset/{n}.png` and at `facesets/{n}.png`, which is the route the client loads. Both
copies carry the same SHA-256 recorded in the pack manifest, and both are re-hashed by the test
suite, so the served copy cannot diverge from the retained provenance copy.

Sprites `4` and `8` are shipped by the pack but are **excluded** from the roster, because their
sheets contain only two rows (idle and one walk row) and cannot supply the four-direction walk
animation the tile renderer expects. Their absence is recorded in the pack manifest itself
(`recommendedAnimatedRoster`) and is asserted by the test suite; it is not a licence restriction.

## What is deliberately *not* claimed here

- **No engine code or game asset was copied.** The reviewed Luanti, Terasology, Paper and
  Minecraft-tooling projects in `docs/VOXEL_ENGINE_REUSE.md` contributed design reasoning only.
  Nothing in this directory is a translation, port or decompilation of those codebases.
- **Three.js is a renderer dependency, not a content asset.** The MIT-licensed bundle in
  `assets/vendor/` is traced in `assets/vendor/three-source-manifest.json`. Its licence does not
  apply to these definitions, and these definitions grant no rights over it.
- **No Minecraft content of any kind.** No block model, texture, name list or data file from
  Minecraft is included.
- **No font or icon file is bundled by this layer.** The DM Sans, Space Grotesk and Lucide notices
  in [`assets/THIRD_PARTY.md`](../assets/THIRD_PARTY.md) govern those files only.

## Adding or changing an entry

1. Create `content/<kind>/<id>.json` using the envelope in `content/README.md`.
2. Record the real provenance in `license`. If the definition is original project work, say so with
   `LicenseRef-NemoWorld-Project-Authored`; do not copy an unrelated asset's licence. If it derives
   from a third-party asset, cite the author, source URL, pinned commit, notice file and notice
   hash, and list every referenced file in `assets` with its SHA-256.
3. Run `node scripts/seal-content.mjs`. It hashes every entry file and every referenced asset,
   verifies each declared `notice_sha256` against the file on disk, and rewrites
   `content/content-manifest.json`, `content/notices.json` and `content/index.js`. It is
   deterministic: running it twice leaves the working tree unchanged.
4. Run `node --test tests/content.test.js`. It re-hashes every file, re-checks every licence and
   notice, and fails if the definitions have drifted from the code they describe.

If a definition cannot be attributed confidently, that must be written down in the entry's `notes`
rather than left blank or filled with a plausible-sounding guess.
