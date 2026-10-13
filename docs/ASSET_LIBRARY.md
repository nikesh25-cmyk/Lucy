# Unified asset library

Task 30's deliverable: **one coherent asset family**, its rights record and a visual contact sheet.
Written 2026-10-13 on branch `task-30-asset-library`.

| File | What it is |
| --- | --- |
| `docs/ASSET_LIBRARY.md` | This document: the family, the evidence for choosing it, and the coherence argument |
| [`docs/assets/asset-manifest.json`](assets/asset-manifest.json) | The machine-readable manifest: 51 selected entries with licence, notice text, modification permission, format, measured polycount, download size, **scale, orientation, collision footprint and intended use**, plus 13 verified-but-unselected candidates and 15 unresolved rights. It is self-describing: a `field_notes` block defines all 15 fields, `status` says whether an entry is produced, vendored, specified or blocked, and `counts_by_status` / `blocked_candidate_count` make the totals checkable |
| [`docs/assets/ATTRIBUTION.md`](assets/ATTRIBUTION.md) | The attribution register: every selected entry's licence and the exact notice text required, including the project-authored ones |
| [`docs/assets/contact-sheet.html`](assets/contact-sheet.html) | A self-contained local contact sheet: 51 original SVG/CSS cards with id, category and licence status, and labelled placeholders for what is not produced |

## What this is, and what it is not

It is a **selection plus its rights record**. It reads the existing verified research
([`docs/research/ASSET_SHORTLIST.md`](research/ASSET_SHORTLIST.md), 25 candidates across six
categories, checked 2026-10-12) and makes the selection decision that research deliberately left open.

It is **not** an integration and **not** a render:

- No asset was downloaded, extracted, converted, imported or integrated. No file under `assets/` was
  added, replaced or downloaded, and `assets/THIRD_PARTY.md` is unchanged.
- No renderer, server route, CSP rule or stylesheet changed. `app.js`, `index.html`, `style.css`,
  `nemo-theme.css`, `content/**` and `src/**` are untouched by this task.
- **No browser check of the game was performed.** The contact sheet HTML was opened locally against a
  throwaway static server to confirm that this documentation file renders as intended; that is a check
  of the document, not of the world, the renderer or any asset.
- Audio is out of the family's scope. Three audio candidates with verified licences are carried
  forward as blocked candidates in the manifest so the research is not lost.

## The decision: one family, "the NemoWorld Commons set"

**The family is original project-authored cube geometry, plus the two third-party art sets already
vendored in this repository that the existing code paths can already address.** No third-party 3D mesh
pack is selected.

The evidence, in the order it decides the question:

| # | Finding | Where it is verified |
| --- | --- | --- |
| 1 | The pinned renderer has **no model loader**: importing `assets/vendor/three-voxel.js` yields exactly 27 symbols and **no `GLTFLoader`, `OBJLoader` or `TextureLoader`**. The bundle is 551,333 bytes, SHA-256 `37fe9184…5e88`. | Re-measured by this task on 2026-10-13; the same values are in [`assets/vendor/three-source-manifest.json`](../assets/vendor/three-source-manifest.json) and `docs/VOXEL_WORLD.md` §Local dependency |
| 2 | **No licensed pack is a drop-in.** Every 3D candidate in the research records integration cost *High* for the same reason, and none is grid-aligned: organic low-poly (Kenney Nature Kit), modern suburban (Kenney City Kit), rigged humanoids (KayKit Adventurers), hex tiles on a square grid (KayKit Medieval Hexagon). | [`docs/research/ASSET_SHORTLIST.json`](research/ASSET_SHORTLIST.json) `integration_cost` per candidate |
| 3 | **Re-bundling the renderer was already rejected.** Adding a loader means re-bundling and re-hashing a pinned, hash-verified dependency. | `docs/research/ASSET_SHORTLIST.md` §What a selection would still require, point 2; [`docs/VOXEL_ENGINE_REUSE.md`](VOXEL_ENGINE_REUSE.md) |
| 4 | **Per-file terms inside every pack archive are unread**, because reading them requires the download this task forbids. No pack can be called fully verified today. | `docs/research/ASSET_SHORTLIST.json` `unresolved_rights_register` |
| 5 | **The content layer already answers the same question the same way**: every block, furniture, crop and cosmetic definition is `LicenseRef-NemoWorld-Project-Authored` with `appearance.geometry: "cube"` or a builder name in `src/voxel-world.js`. | `docs/CONTENT_DEFINITIONS.md`, [`content/THIRD_PARTY.md`](../content/THIRD_PARTY.md) |
| 6 | **Two vendored sets already work through existing paths**: the CC0 mayor sheets load through the 2D canvas atlas route, and Lucide SVGs are served as files and tinted in CSS. Neither needs a loader, a CSP change or a dependency. | `content/appearances/*.json`; `server.js:71`, `app.js:507`, `nemo-theme.css:11` |
| 7 | The world's own code says the same: "The models are original code. No Minecraft assets, logos, or textures are used." | [`docs/VOXEL_WORLD.md`](VOXEL_WORLD.md) |

So the coherent family is not a compromise between packs — it is the one family the renderer can
already draw, extended deliberately rather than assembled from parts that cannot load.

## What is in the family

51 entries: **45 produced, 2 vendored third party, 4 specified with nothing produced**.

| Category | Entries | Produced | Vendored | Specified |
| --- | --- | --- | --- | --- |
| `terrain` | 9 | 9 | – | – |
| `architecture` | 9 | 7 | – | 2 |
| `vegetation` | 9 | 8 | – | 1 |
| `furniture` | 16 | 16 | – | – |
| `characters` | 4 | 3 | 1 | – |
| `ui_icons` | 4 | 2 | 1 | 1 |

- **Terrain** — the seven sealed frontier blocks (grass, stone, wood, glass, brick, sand, path), the
  land ground surface and the water surface.
- **Architecture** — cottage, civic building, shelter, portal frame, gate frame, wall tile, world
  building tile; specified: a distinct civic hall silhouette and a walk-through garden canopy arch.
- **Vegetation** — tree, fruit tree, palm, cactus, rock outcrop, flowers, farm plot, trellis;
  specified: a garden hedge segment.
- **Furniture** — bench, table, workbench, bookshelf, bed, cushion, lamp, lantern, fountain, pond,
  sculpture, display, kitchen, boat, telescope, path object.
- **Characters** — the cube resident body, the calling emblem, the NPC marker, and the vendored CC0
  civic mayor sprite sheets (20 appearances).
- **Interface icons** — the 15 vendored Lucide SVGs, the project mark, the frontier block swatches;
  specified: a library glyph.

## Units an implementer places against

Everything an implementer needs to place an entry without guessing is in the manifest, per entry. The
contract it is expressed against:

| Quantity | Value | Source |
| --- | --- | --- |
| Tile | 1 tile = **1 virtual metre**; land areas are 48 × 48 virtual metres in 8 × 8 parcels of 6 × 6 | `docs/VOXEL_WORLD.md`, `docs/LAND_WORLD.md` |
| Block | 1 × 1 × 1 m cube, block layer `z` an integer **0–7** | `content/README.md` (`stack.z_min`/`z_max`), `VOXEL_LIMITS.height = 8` |
| Axes | world X = tile x, world Z = tile y, world Y = block layer z | `src/voxel-world.js` `cubeBatch` |
| Orientation | every item is axis-aligned, **rotation 0°**, never mirrored; the cottage door, its windows and the world building window sit on the **+y** face (tile y+1) | `src/voxel-world.js` `house()`, `terrainScene()` |
| Resident | 1.52 m tall, 0.38 m half-width; ground detail ≤ 0.10 m; knee height 0.50 m | `src/footprints.js` `RESIDENT_HEIGHT`, `RESIDENT_CLEARANCE`, `GROUND_DETAIL`, `KNEE_HEIGHT` |
| Occupancy | `mass` (occupies its tile, not walkable), `flat` (knee-height detail, walkable), `frame` (open marker, walkable); an unknown type fails closed as a `mass` | `src/footprints.js` |

Rendered vertical extent, so nothing is placed inside anything else (heights in metres; block layers
are `ceil(height)` starting at 0):

| Class | Tallest items | Range |
| --- | --- | --- |
| `mass` (solid) | tree and fruit tree **3.94**; cottage and civic building **2.60**; shelter 2.22; portal 2.28; gate 2.16; lamp and lantern 2.045; cactus 1.90; trellis 1.80; rock 1.80; wall tile 1.70; building tile 1.67; bookshelf 1.60; boat 1.55; fountain 1.45; prop (sculpture, display, kitchen) 1.15; bench 0.865; table and workbench 0.67; bed 0.59; pond 0.13 | 0.13 – 3.94 |
| `flat` (walkable detail) | flowers and farm plot **0.475**; cushion 0.20; thin path surface 0.09 | ≤ 0.50, the knee height the class promises |
| `frame` (walk-through) | portal 2.28; gate 2.16; shelter 2.22 — every cross member is above the 1.52 m resident | posts ≤ 2.3 |

**A worked placement**, so no one has to guess: `arch.cottage` occupies the tile at `(x, y)` with a
1 × 1 m footprint and block layers 0–2 (0 to 2.60 m). Its door, windows and chimney are on the +y
face, so it must be turned by choosing a different template, not by rotating the mesh. The tile is a
`mass`: `src/footprints.js` makes it unwalkable, pathfinding routes around it, placement refuses it on
an occupied tile, and the renderer draws it at full tile width so a neighbouring resident is never
drawn inside it. Its 8 boxes come from `house()` at `src/voxel-world.js:107-119` and are measured, not
estimated.

## The coherence argument

**One palette, already in the repository.** No entry in the family introduces a colour. The manifest's
`family.palette_tokens` names 36 tokens and each entry lists the ones it uses; every value is an
existing renderer tint (`LOCAL_COLORS`), a sealed block colour (`content/blocks/*.json`), a sealed
cosmetic colour (`content/cosmetics/`), or an interface token from `nemo-theme.css`.

| Group | Tokens | Values |
| --- | --- | --- |
| Greens | canopy deep / mid / high, leaf, meadow, cactus | `#438367`, `#6a9f73`, `#8eb189`, `#468969`, `#79a86d`, `#649873` |
| Earth and structure | wood trunk / timber, stone, rock, wall, brick, sand, plaster, prop, steel, portal post | `#81664a`, `#b58c58`, `#a4b1b0`, `#929e9d`, `#839489`, `#c88466`, `#d9c692`, `#d5c4a1`, `#a4b9ab`, `#526f82`, `#78998b` |
| Water and weather | water, glass, snow | `#4b9dad`, `#9dd9e0`, `#e5eeee` |
| Warm highlights | lantern gold, crop gold, cream, terracotta roof, path, fruit, blossom, book, mattress, cushion, skin | `#e2ca83`, `#d5c16e`, `#f1e9cb`, `#bd7961`, `#d7c49c`, `#d7905d`, `#e7cf83`, `#cab573`, `#8bafa2`, `#bfa4a4`, `#d4a17b` |
| Dark | ink | `#324842` |
| Sets, not one colour | 7 sealed agent colours, 8 calling colours, 3 flower heads, 4 skin tones | `content/cosmetics/` |

That palette is the same language [`docs/NEMOEARTH_DESIGN.md`](NEMOEARTH_DESIGN.md) describes for the
shell — "deep forest backgrounds, ivory Cormorant headings, Manrope controls, **subdued gold**,
translucent panels and fine borders" — and the interface tokens it names are what the family's
highlight colours resolve to: `--bg #051d18`, `--panel #12382e`, `--ink #f1f0df`, `--gold #ded6a5`.
The renderer's lantern gold `#e2ca83` and the interface's `#ded6a5` are deliberately **two tokens**,
not one: the comment at `src/voxel-world.js:8-11` records that an agent cosmetic of the same name is a
deeper tone, so neither may stand in for the other. The family keeps that distinction instead of
smoothing it over.

**One scale.** Everything is authored at 1 tile = 1 m with a 1.52 m resident. Nothing is resized to
fit; a palm is 2.69 m because that is what the code draws, and a bookshelf is 1.60 m because that is
the height at which it reads as a bookshelf beside a 1.52 m resident. The only multi-tile item in the
family is a specification (`arch.civic-hall`, 2 × 2), and it is marked as not produced precisely
because it would break the one-tile rule the rest of the family obeys.

**One silhouette and polycount budget.** Every produced item is axis-aligned `BoxGeometry(1,1,1)`
instances with flat-shaded `MeshLambertMaterial`: no texture, no UV, no mesh file, no image. Measured
over the real builder:

- **1 to 13 boxes per item** (12 to 156 triangles): the cushion and the path object are 1 box, the
  bookshelf is 13. A resident is 12 boxes (144 triangles), plus 4–5 for a calling emblem and 4 for an
  NPC marker.
- A terrain cell is 2 boxes (one base cube, culled when enclosed, plus a 0.08 m surface slab);
  water is 3.26, a bridge 6, a wall 3, a building tile 4, a garden cell 6 including its flowers.
- A full 37 × 37 window (1,369 cells) measures 2,750 boxes on plain land and **8,230 boxes =
  98,760 triangles** in the worst measured case (a uniformly garden surface). Batches are one
  `InstancedMesh` per colour and material style, so the budget is boxes, not draw calls, against
  hard limits of 1,369 cells, 260 scenery objects, 2,048 blocks and 220 participants.

The family therefore has a **measurable** silhouette grammar rather than a stylistic assertion: chunky
stepped roofs, canopies that begin above head height so a neighbour is never drawn inside them, and
ground detail that never exceeds the knee height its walkable class promises.

**One restraint, stated by the design language itself.** `docs/NEMOEARTH_DESIGN.md` says the release
"does not claim a new three-dimensional globe, new terrain geometry or **photorealistic assets**". An
untextured flat-shaded cube family is the asset-side expression of that same restraint — and it is also
the only thing the pinned bundle can draw, because it has no image decoder. The aesthetic choice and
the engineering constraint agree, which is why this family is coherent rather than merely convenient.

**Why these six categories belong to the same game.** They compose in one diorama: terrain is what a
resident stands on; buildings are the only place a resident is enclosed; vegetation gives the commons
its silhouette and its altitude; furniture is what a resolved fixture acts on (a bench posture, a
crafting station, a farm tile); characters are the residents who act, drawn in the same box grammar at
the same scale; interface icons name those same actions in the shell that frames the world. A player
never sees them alone — they see a 37 × 37 window in which a cottage, a trellis, a bench and an avatar
are drawn by the same builder, in the same palette, inside the same tile rule.

## Verified versus specified-but-unproduced

**Produced and measured (45 entries).** The geometry exists in `src/voxel-world.js` or `world.js` and
is drawn today. Every polycount in the manifest is **measured** by importing the real builder and
reading `createVoxelScene().update().stats`, not estimated from a screenshot or a publisher claim.

**Vendored third party, licence read at the rights holder's own file (2 entries).**

- `char.mayor-sprite-sheet` — 20 appearances, CC0 1.0, Pixel-boy / Sparklin Labs, pinned commit
  `e8674a03…`, notice file [`assets/mayors/LICENSE.txt`](../assets/mayors/LICENSE.txt) with a recorded
  digest.
- `ui.nav-icon-set` — 15 SVGs, ISC, Lucide `lucide-static` 1.55.0, with four icons
  (`chevron-right`, `compass`, `log-in`, `x`) under Feather's MIT, both notices retained in
  [`assets/icons/LICENSE.txt`](../assets/icons/LICENSE.txt).

Neither is new: both were vendored before this task, and this task adds no file to `assets/`.

**Specified with nothing produced (4 entries).** Each is a gap this task found by reading the code, not
an invented requirement, and each is drawn in the contact sheet as a labelled placeholder that says
exactly what is missing:

| Entry | Why it is specified | What producing it would need |
| --- | --- | --- |
| `arch.civic-hall` | `house()` branches only on `"shelter"`, so the sealed `civic-building` type draws the cottage branch. Measured: 8 boxes and an identical material set to a cottage. The sealed definition's own note claims a "large 2.5 × 2 building" that the code does not draw. | A new `content/furniture` entry and a **content re-seal**, plus a `house()` branch; a 2 × 2 mass would also need four occupied tiles in `src/footprints.js` and a placement-policy change |
| `arch.canopy-arch` | The frame vocabulary is `gateway`, `shelter`, `portal`, `gate`; there is no overhead arch over a garden path, and `veg.trellis` is a flat two-post panel with a `mass` footprint. | A builder branch keeping posts in the tile-edge bands and cross members above 1.52 m |
| `veg.hedge-row` | The 27 sealed furniture entries contain no hedge: a garden parcel has no low continuous green mass to enclose it. | A `content/furniture/hedge.json` entry, a content re-seal and a builder branch |
| `ui.asset-library-glyph` | The vendored set has no library, catalogue or collection glyph. | Choosing an icon and reading its own licence first (Lucide ISC, or game-icons.net per contributor) |

## Unresolved rights

The manifest's `unresolved_rights` array carries **15 entries** with a severity, the subject, the
detail and the action. The ones that decide what may happen next:

1. **No root LICENSE** (`blocking-for-redistribution`). The repository has no `LICENSE`, `COPYING` or
   `LICENCE` file, and `package.json` is `private` with no `license` field, so **49 of the 51 entries
   have no stated redistribution terms**. This is an owner decision and this task does not attempt to
   resolve it.
2. **No renderer loader** (`blocks-every-mesh-pack`). Every licensed 3D pack needs a decision about
   re-bundling the pinned, hash-verified Three.js bundle before it can even be considered.
3. **Archive-internal terms unread** (`open-verification`) for every Kenney and KayKit candidate: the
   licence was read at the publisher's own page or repository file, but the `License.txt` inside the
   distributed archive has not been inspected, because that requires a download.
4. **Terasology PlantPack** has **no asset-level licence at all** — the one candidate in the 25-read
   research set flagged unverified. Study only; do not integrate.
5. **Quaternius QAL v1.0 §3a** forbids redistributing the assets as assets, and whether serving model
   files to a browser is such a redistribution is ambiguous. Do not integrate without clarification.
6. **Luanti `minetest_game` media** is CC BY-SA 3.0 with an unenumerated per-file exception list;
   share-alike on derivative artwork is a legal question, not an engineering one.
7. **Two observed inconsistencies in the sealed layer**, reported and not fixed because `content/**` is
   sealed and not owned by this task: the `civic-building` note describes geometry the renderer does
   not draw, and the `pond` note says the voxel renderer has no pond builder when the branch exists at
   `src/voxel-world.js:128` and a measured pond draws that branch's water colour `#4b9dad`.
8. **A third, in the stylesheet:** the frontier hotbar swatches in `nemo-theme.css:45` are hand-picked
   tints that no test asserts against `content/blocks/*.json` (wood is drawn `#b58c58`, swatched
   `#a78354`). Recorded so an implementer does not assume the swatch is the drawn colour; fixing it
   means editing a file task 30 does not own.

Nothing in the family may be treated as cleared for distribution until item 1 is answered.

## The contact sheet, and how to read it honestly

`docs/assets/contact-sheet.html` is a single local file: no network request, no external font, no
image, no script beyond its own markup, and no new dependency. It is generated from
`asset-manifest.json`, so the sheet and the manifest cannot drift.

- Each card gives the entry's **id, category, licence status** and its measured/derived fields.
- Each swatch is a **box-count glyph, not a picture of the object**: one cube per measured box, in that
  entry's own palette token, capped at 13 with a label when there are more. It is a count, not a shape
  preview, and the page says so at the top.
- The four specifications are drawn as **`NOT PRODUCED`** placeholders with a "What is missing" box
  that names the exact code path, file or licence gap. There are no unexplained placeholders: every
  placeholder states what is absent and what producing it would require.

## Non-claims and limitations

- **Nothing is integrated.** No asset file, no `assets/` entry, no server route, no CSP change, no
  renderer change, no UI change. Task 38 owns the wiring of `app.js`, `index.html`, `style.css` and
  `nemo-theme.css`, and this task does not pre-empt it.
- **No browser check of the game was performed**, and none is claimed. The contact sheet document was
  opened locally to confirm that it renders.
- **No new research was started.** Every licence statement here traces to the 2026-10-12 verification
  recorded in `docs/research/ASSET_SHORTLIST.json`, and the licence URLs it already stores.
- **The family covers one visual path.** It does not cover audio, rigged animation, textures or
  high-resolution imagery, and it does not pretend those are solved.
- **Polycounts and download sizes for third-party packs remain unknown** for every 3D pack except the
  OpenGameArt vegetation pack, because nothing was downloaded. Only the family's own items carry a
  measured polycount.
- **The contact sheet is a document, not a QA artifact.** It is not a screenshot, not a render and not
  evidence that any geometry draws correctly in a browser.
- **The four specifications need a content re-seal**, which is a separate reviewed step: three of them
  would change the sealed content layer, and `content/**` was deliberately not touched here.
