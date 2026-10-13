# Attribution register — NemoWorld Commons set

Every selected asset's licence and the **exact notice text a distribution must carry**, for the family
selected by [Task 30](../ASSET_LIBRARY.md) and recorded machine-readably in
[asset-manifest.json](asset-manifest.json). Written 2026-10-13.

This register is a rights record for a **selection**, not a record of anything shipped: nothing it
lists was downloaded, imported or integrated by Task 30. It adds no binary to the repository, and it
does not modify `assets/THIRD_PARTY.md`, which remains the register for the binaries that are actually
vendored today (the DM Sans and Space Grotesk fonts, the Lucide SVGs, the pinned Three.js bundle and
the mayor sheets).

## The repository has no root LICENSE

**The repository contains no `LICENSE`, `COPYING` or `LICENCE` file, and `package.json` declares
`"private": true` with no `license` field.** There is therefore no repository-wide licence a consumer
could rely on, and nothing here implies one. Tasks 30 did not add a root licence, and adding one is an
owner decision, not a documentation task.

The practical consequence, stated plainly: **49 of the 51 selected entries are original project work
whose redistribution terms are unstated.** They are recorded under a locally defined SPDX `LicenseRef`
rather than an invented standard identifier:

| SPDX identifier | Meaning recorded for these entries | Entries |
| --- | --- | --- |
| `LicenseRef-NemoWorld-Project-Authored` | Original work written for this project. No third-party asset was copied, traced, decompiled or translated to produce it. **The repository grants no distribution licence today**, so redistribution terms are unstated and must be obtained from the project owner. | 49 |
| `CC0-1.0` | Released under CC0 1.0 Universal by its author. | 1 (`char.mayor-sprite-sheet`) |
| `ISC` (with four Feather-derived icons under `MIT`) | Released under the ISC licence by the Lucide project. | 1 (`ui.nav-icon-set`) |
| unresolved | No icon has been chosen, so no licence can be recorded. | 1 (`ui.asset-library-glyph`, a specification) |

`LicenseRef-NemoWorld-Project-Authored` is deliberately **not** `MIT`, not the Three.js licence, not
the SIL Open Font License of the bundled fonts and not the ISC/MIT notice of the Lucide icons. Those
terms cover other files in this repository and must not be stretched to cover project artwork. This is
the same rule the sealed content layer already applies in
[`content/THIRD_PARTY.md`](../../content/THIRD_PARTY.md), and Task 30 follows it rather than inventing
a second convention.

## Notice text required, by licence

### `LicenseRef-NemoWorld-Project-Authored` — 49 entries

Applies to: the seven terrain blocks and the land and water surfaces; the cottage, civic building,
shelter, portal frame, gate frame, wall and world building tile; all eight produced vegetation items;
all sixteen produced furniture and props; the resident avatar, the calling emblem and the NPC marker;
the NemoWorld mark and the frontier block swatches; and the four specifications (`arch.civic-hall`,
`arch.canopy-arch`, `veg.hedge-row`, `ui.asset-library-glyph`), which carry the identifier only for
consistency — nothing has been produced for them.

**Required notice text on distribution:**

> Original geometry, layout and colour for NemoWorld. No third-party asset was copied.
> Redistribution terms for this work are not stated; the repository carries no `LICENSE` file.
> See `content/THIRD_PARTY.md`.

**What a distributor must do:** reproduce the sentence above with the distributed copy, and obtain
redistribution terms from the project owner first. Because there is no root licence, a distributor
cannot assume permission to redistribute; the only honest statement available today is that the terms
are unstated.

**Notice file recorded per entry:** `content/THIRD_PARTY.md`, SHA-256
`4a0a390c9d4e1951939e4f9672b103fdf026a574d5566ed6c5e0295636c7bf60` (the sealed digest, re-verified
from disk when this register was written and by `tests/content.test.js`).

### `CC0-1.0` — `char.mayor-sprite-sheet`

The 20 civic mayor appearances (character sheets and portrait facesets) come from the Ninja Adventure
pack by **Pixel-boy / Sparklin Labs**, pinned at commit `e8674a03ab4456802f71f848c4df79eccca23f7a`,
vendored 2026-10-11 at [`assets/mayors/`](../../assets/mayors/).

**Required notice text:** none. CC0 1.0 Universal waives copyright and imposes no credit obligation.

**Recommended courtesy credit** (kept for provenance, not required):

> Civic mayor sprites: Pixel-boy / Sparklin Labs, "Ninja Adventure" character pack, CC0 1.0.
> https://github.com/sparklinlabs/superpowers-asset-packs

**Notice file retained:** [`assets/mayors/LICENSE.txt`](../../assets/mayors/LICENSE.txt) — the CC0 1.0
deed, SHA-256 `36ffd9dc085d529a7e60e1276d73ae5a030b020313e6c5408593a6ae2af39673`, re-hashed by the test
suite. Per-file digests are in [`assets/mayors/manifest.json`](../../assets/mayors/manifest.json).

**Not covered by CC0:** the roster selection, the `/assets/mayors/characters/{n}.png` and
`/assets/mayors/facesets/{n}.png` routes, the frame layout mapping and the placement code are project
work under `LicenseRef-NemoWorld-Project-Authored`.

### `ISC` with Feather-derived `MIT` — `ui.nav-icon-set`

The 15 vendored interface icons come from **Lucide** (`lucide-static` 1.55.0), at
[`assets/icons/`](../../assets/icons/). Four of the fifteen — `chevron-right`, `compass`, `log-in`
and `x` — are listed in Lucide's own licence file as derived from the **Feather** project under MIT.

**Required notice text on distribution:** retain both notices below.

> ISC License
>
> Copyright (c) 2026 Lucide Icons and Contributors
>
> Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee
> is hereby granted, provided that the above copyright notice and this permission notice appear in all
> copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
> SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
> AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
> WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
> NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
> THIS SOFTWARE.

and, for `chevron-right`, `compass`, `log-in` and `x`:

> The MIT License (MIT)
>
> Copyright (c) 2013-present Cole Bemis
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial
> portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
> OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
> CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

**Notice file retained:** [`assets/icons/LICENSE.txt`](../../assets/icons/LICENSE.txt), SHA-256
`b495047bd93a9b06913511076f504daba17d5bbeb3e0650f3bb53a4220329c57` — it holds both notices plus the
per-icon Feather derivation list.

**For any icon added later:** the Feather derivation list is **per icon**, so each new glyph must be
checked against that list before it is vendored, and the MIT notice extended if the new glyph is listed.

### Unresolved — `ui.asset-library-glyph`

A specification with nothing produced behind it. No icon, no file and no chosen source, so no licence
and no notice can be recorded. If a Lucide glyph is chosen, the ISC/Feather split above applies. If a
**game-icons.net** glyph is chosen, its per-contributor entry must be read first, because that project
is CC BY 3.0 overall with per-contributor CC0 exceptions (see below).

## Notice text a future selection would require

These are the verified candidates Task 30 did **not** select. Their required notice text is recorded
here so a later selection starts from facts rather than from a fresh reading. Nothing below is
selected, and none of it may be integrated without its own review.

| Candidate | Licence as read at the rights holder's own file | Notice text required |
| --- | --- | --- |
| Kenney Nature Kit, City Kit (Suburban), Furniture Kit, Blocky Characters, RPG Audio, UI Pack | CC0 1.0 Universal, stated on the publisher's own asset page | None required. Courtesy credit to kenney.nl recommended. |
| KayKit Adventurers 1.0, Medieval Hexagon 1.0, City Builder Bits 1.0, Furniture Bits 1.0, Restaurant Bits 1.0, Dungeon Pack 1.1 | CC0, in the publisher's own `LICENSE.txt` in the official repository | None required. Crediting Kay Lousberg is requested but not mandatory. **The paid EXTRA and SOURCE tiers are separate deliveries and must not be used.** |
| KayKit Forest Nature Pack (FREE tier) | CC0, but stated on the itch product page only | None required by CC0. The licence file inside the free archive has never been read. |
| Terasology ChrisVolume1OST (8 tracks) | Apache License 2.0, `LICENSE` beside the tracks | Reproduce the Apache-2.0 licence text, retain any `NOTICE`, and **state that files were changed** if the tracks are re-encoded. Practical credit: "Music: Chris Köbke (Chris' Terasology OST Volume 1), Apache-2.0". The module has no `NOTICE` file, so the notice obligations should be confirmed with the project before shipping. |
| Google Material Symbols | Apache License 2.0 for the icons (repository `LICENSE` and README §License) | Reproduce the Apache-2.0 licence text and applicable notices, and state changes. Vendor SVGs only: the repository's **font builds may carry their own terms**. |
| game-icons.net icons | CC BY 3.0 overall, with **per-contributor** CC0 exceptions listed in the repository `license.txt` | For a CC BY 3.0 icon, the publisher's suggested form: `Icons made by {author}. Available on https://game-icons.net`. Each chosen icon's contributor entry must be read first, because some contributors released under CC0 and need no credit. |
| Luanti `minetest_game` media | CC BY-SA 3.0 with per-file exceptions, from the repository `LICENSE.txt` | Non-trivial: reproduce the per-file attribution entry for every selected texture, credit the mod authors named in each mod's README, **mark modifications**, and accept the share-alike obligation on derivative artwork. The CC BY 3.0 exception list has not been enumerated. |
| Quaternius Ultimate Modular Men Pack | Quaternius Asset License (QAL) v1.0, a custom licence | None required by QAL v1.0 §2 — but §3a forbids redistributing the assets as assets, and whether web delivery counts is unresolved. **Do not integrate without written clarification.** |
| Freesound `Rain_Ambience` (VanEngelen) | CC0, stated on the file's own page | None required. The page offers a generated attribution string for optional credit. Downloading needs an account, so the page state was never captured. |
| Terasology PlantPack | **No asset-level licence at all** | Unknown per asset. **Do not integrate.** An engine's licence does not licence its assets, and this module publishes no asset-level terms. |

## How to add an entry to this register

1. Read the licence at the **rights holder's own** document or page — a `LICENSE`/`COPYING`/
   `LICENSE.txt` in the official repository, or the rights holder's own asset or terms page. Badges,
   blog posts, wiki summaries and third-party "CC0 list" pages are not evidence.
2. Vendor the file, hash it, and add the digest to [`assets/manifest.json`](../../assets/manifest.json)
   (or the pack's own manifest, as the mayor sheets do).
3. Record the entry in [`asset-manifest.json`](asset-manifest.json) with its licence, notice text,
   modification permission, scale, orientation and collision footprint, and re-run the contact sheet
   so the two cannot drift.
4. Quote the exact notice text above with the entry, and copy the licence file into the repository.
   Never leave the notice text implicit.
5. If the licence cannot be read at the source, record the right as **unresolved** and mark the entry
   `status: "blocked"` rather than assuming a licence.
