# Licensed open assets shortlist

Research deliverable for **Task 09 — licensed open assets shortlist**. Written 2026-10-12.

This document reviews reusable original art and audio that could serve the existing browser
Three.js voxel world. It is **research only**: no asset, archive, model, texture or sound was
downloaded, extracted, converted or integrated. The machine-readable version of the same survey
is [ASSET_SHORTLIST.json](ASSET_SHORTLIST.json) (25 candidates, 15 fields each). Where the two
disagree, the JSON holds the raw measurement and this file holds the reasoning.

## What the world actually needs

The shortlist is judged against the renderer that exists, not against a generic game:

| Constraint | Where it is visible | Consequence for asset selection |
| --- | --- | --- |
| Everything is an instanced **1 m cube** with a flat colour | `src/voxel-world.js` `createResources`, `cubeBatch`, `tree`, `house`, `furniture` | Rigged or textured meshes are a new geometry path, not a drop-in |
| Renderer bundle has **no model loaders** | `assets/vendor/three-voxel.js` exports 27 symbols (checked 2026-10-12); no `GLTFLoader`, `OBJLoader` or `TextureLoader` | Any mesh pack needs a loader, and the bundle is pinned by hash so re-bundling has a cost |
| Muted, garden-and-civic palette | `LOCAL_COLORS` in `src/voxel-world.js`; the sealed `content/` layer | Packs whose palette clashes cannot be recoloured cheaply |
| No audio subsystem exists | no `AudioContext`, `<audio>` element or audio route in `app.js`, `server.js` or `src/` | Ambient audio is new code; bundled same-origin media is already allowed by the CSP |
| Content policy is explicit | `default-src 'self'` in `server.js`; `assets/THIRD_PARTY.md`, `assets/manifest.json`, `content/THIRD_PARTY.md` | Any adopted file must be vendored, hashed and recorded like the existing fonts, icons and mayor art |

The current world already uses verified CC0 art in two places: the Lucide icon subset and the
Ninja Adventure mayor sheets (`assets/mayors/`, pinned to commit
`e8674a03ab4456802f71f848c4df79eccca23f7a`, hashes in `assets/mayors/manifest.json`). Those are
the in-repo precedent for how a new asset would be recorded.

## What was searched

- **Kenney** (`kenney.nl`): 11 asset pages checked directly, including their download endpoints.
- **KayKit / Kay Lousberg** (`kaylousberg.itch.io` plus the official `KayKit-Game-Assets` GitHub
  repositories, which carry a `LICENSE.txt` per pack).
- **Quaternius** (`quaternius.com`): pack pages plus the publisher's own licence page.
- **OpenGameArt** (`opengameart.org`): per-item pages and the CC0-filtered search index.
- **Freesound** (`freesound.org`): per-sound pages, where each file carries its own licence.
- **Luanti** (`luanti-org/minetest_game`) and **Terasology** (`Terasology/*` modules, plus the
  engine README licence statement).
- **Icon and font-adjacent projects**: Lucide, Google Material Symbols, game-icons.net, Tabler.
- **Rejected or unreachable**: FreePD (closed), Pixabay audio and Sonniss GDC (HTTP 403 from this
  environment), Unity Asset Store, Sketchfab ND/NC models, ZapSplat-style subscription libraries.

## Verification standard

A licence counts as verified only when the rights holder's **own** text was read:
a `LICENSE` / `COPYING` / `LICENSE.txt` in the official repository, or the rights holder's own
asset or terms page. Badges, blog posts, aggregator "CC0 lists" and wiki summaries were never
treated as evidence, and an engine's licence was never extended to its bundled media. The exact
URL for every check is in `license_verified_at_url` with `license_checked: 2026-10-12`.

Two consequences of that rule are worth stating plainly:

- **24 of 25 candidates** have a licence verified at the rights holder's own document or page.
- **1 candidate (Terasology PlantPack)** has **no** asset-level licence at all and is recorded as
  unverified. Nothing about it should be treated as cleared.

## Usable assets — licence verified, ready for a selection decision

These are candidates whose licence was read at the rights holder's own document or page and whose
licence permits modification and reuse. "Usable" is a licensing statement, not an integration
decision: no asset here has been downloaded or wired into the world. Two rows are honest
exceptions inside this section: the Luanti `minetest_game` media is licence-clean but a poor visual
fit, and Quaternius is listed only because it is the strongest modular-avatar candidate while its
licence (QAL v1.0) is an integration blocker — both are explained in place and in the
unresolved-rights register.

### Vegetation

| Candidate | Licence (evidence) | Size | Fit |
| --- | --- | --- | --- |
| [Kenney Nature Kit](https://kenney.nl/assets/nature-kit) v1.0 | CC0 1.0 | 10.05 MiB (measured) | Best licensed 3D nature pack; organic low-poly, not cubes |
| [KayKit Forest Nature Pack](https://kaylousberg.itch.io/kaykit-forest) FREE tier | CC0 (product page) | not published | Best-looking licensed forest set; textured atlas, not cubes |
| [rubberduck vegetation pack](https://opengameart.org/content/free-vegetation-asset-pack) | CC0 (item page) | 5.1 MB | Only candidate with **published polycounts** (LOD tri counts); mid-poly |
| [minetest_game media](https://github.com/luanti-org/minetest_game) | CC BY-SA 3.0 + per-file exceptions (`LICENSE.txt`) | n/a | Licence-clean but a **poor** visual fit: 16 px Minecraft-adjacent pixel art |

### Architecture

| Candidate | Licence (evidence) | Size | Fit |
| --- | --- | --- | --- |
| [Kenney City Kit (Suburban)](https://kenney.nl/assets/city-kit-suburban) v2.0 | CC0 1.0 | 2.90 MiB (measured) | Closest shapes to the world's cottages and gardens |
| [Kenney Castle Kit](https://kenney.nl/assets/castle-kit) v2.0 | CC0 1.0 | 2.13 MiB (measured) | Stone palette fits; martial vocabulary fits a peaceful world poorly |
| [KayKit Medieval Hexagon Pack](https://kaylousberg.itch.io/kaykit-medieval-hexagon) 1.0 | CC0 (`LICENSE.txt` in official repo) | not published | Hex tiles cannot sit on the square 1 m grid |
| [KayKit City Builder Bits](https://kaylousberg.itch.io/city-builder-bits) 1.0 | CC0 (`LICENSE.txt` in official repo) | not published | Modern-city vocabulary; usable subset only |

### Furniture

| Candidate | Licence (evidence) | Size | Fit |
| --- | --- | --- | --- |
| [Kenney Furniture Kit](https://kenney.nl/assets/furniture-kit) v1.0 | CC0 1.0 | 4.89 MiB (measured) | Direct counterpart to the 27 sealed `content/furniture` entries |
| [KayKit Furniture Bits](https://kaylousberg.itch.io/furniture-bits) 1.0 | CC0 (`LICENSE.txt` in official repo) | not published | Interior decoration for cottages and studies |
| [KayKit Restaurant Bits](https://kaylousberg.itch.io/restaurant-bits) 1.0 | CC0 (`LICENSE.txt` in official repo) | not published | Counters and food props for communal spaces |
| [KayKit Dungeon Pack](https://kaylousberg.itch.io/kaykit-dungeon-pack) 1.1 | CC0 (`LICENSE.txt` in official repo) | not published | Barrels, crates and chests fit; traps and weapons must be left out |

### UI icons

| Candidate | Licence (evidence) | Size | Fit |
| --- | --- | --- | --- |
| [Lucide](https://github.com/lucide-icons/lucide) (`lucide-static` 1.55.0) | ISC (`LICENSE`); Feather-derived icons MIT | already vendored | Already the interface's icon language — the cheapest safe route |
| [Google Material Symbols](https://github.com/google/material-design-icons) | Apache-2.0 (`LICENSE`, README §License) | not measured | Huge coherent family; mixing two icon styles is a design decision |
| [game-icons.net](https://github.com/game-icons/icons) | CC BY 3.0 (site); per-contributor CC0 exceptions (`license.txt`) | not measured | Cherry-pickable emblems for callings and objectives; credit required |
| [Kenney UI Pack](https://kenney.nl/assets/ui-pack) v2.0 | CC0 1.0 | 1.17 MiB (measured) | Raster panels/buttons; largely duplicates existing CSS work |

### Avatar variants

| Candidate | Licence (evidence) | Size | Fit |
| --- | --- | --- | --- |
| [KayKit Adventurers](https://kaylousberg.itch.io/kaykit-adventurers) 1.0 | CC0 (`LICENSE.txt` in official repo) | not published | Best-documented humanoid set; replaces the code-built cube avatar |
| [Kenney Blocky Characters](https://kenney.nl/assets/blocky-characters) v2.0 | CC0 1.0 | 2.05 MiB (measured) | Closest published match to the existing blocky silhouette |
| [Quaternius Ultimate Modular Men Pack](https://quaternius.com/packs/ultimatemodularcharacters.html) | **QAL v1.0, not CC0** — see unresolved rights | not published | Modular parts are attractive but the licence is a blocker |

### Ambient audio

| Candidate | Licence (evidence) | Size | Fit |
| --- | --- | --- | --- |
| [Terasology ChrisVolume1OST](https://github.com/Terasology/ChrisVolume1OST) | Apache-2.0 (`LICENSE` beside the tracks) | 1.22 MB + 2.58 MB measured (two tracks) | Calm OST, including a track named `PeacefulWorld.ogg` |
| [Forest Ambience](https://opengameart.org/content/forest-ambience) (TinyWorlds) | CC0 (item page) | 716.7 KB | Exactly the commons/frontier register |
| [Contemplation](https://opengameart.org/content/contemplation-0) (Joth) | CC0 (item page) | 2.4 MB | Uploader-tagged loop for reflective moments |
| [Kenney RPG Audio](https://kenney.nl/assets/rpg-audio) v1.0 | CC0 1.0 | 0.92 MiB (measured) | 50 short cues for movement, building and receipts |
| [Rain_Ambience](https://freesound.org/people/VanEngelen/sounds/704579/) (VanEngelen) | CC0 (file page) | 15.9 MB WAV | Weather bed; needs re-encoding before web delivery |

## Visual references — study only, not reusable as-is

1. **Terasology PlantPack** — 146 pixel block textures with **no licence file** in the module and
   no credits list. The engine README states artwork is CC BY 4.0 "unless indicated otherwise -
   see credits for minor exceptions", which identifies neither these files nor their authors.
   Study only; the JSON records `license_verified_from_publisher_file: false`.
2. **Other Terasology art modules** reviewed and deliberately left out of the JSON for the same
   reason: `CoreAssets` (102 image files, including `blockTiles/ChestFront.png`,
   `blockTiles/FurnaceFront.png`, `blockTiles/CobbleStone.png`), `MedievalCities` (prefab JSON only,
   36 files, no textures), `HumanoidCharacters` (four `.gltf` humanoids plus 15 PNG skins),
   `Furnishings` (Java logic only, no assets) and `GrowingFlora` (shape and prefab metadata only).
   `ChrisVolume1OST`, `ChrisVolume2OST`, `LegacyMusic`, `StaticCities`, `AdventureAssets` and
   `StructuralResources` *do* carry a `LICENSE` (Apache-2.0) and are a different case.
3. **Quaternius packs** — usable only as a visual reference until the QAL redistribution question
   in the next section is answered.
4. **Terasology LegacyMusic** — Apache-2.0 `LICENSE` at the repository root, but its README credits
   individual tracks to third parties, including a Kevin MacLeod piece sourced from **FreePD**,
   which has ceased operating and whose public-domain statement can no longer be checked at the
   source. Per-track re-verification is required, so it is not listed as a clear candidate.
5. **KayKit paid tiers** (EXTRA and SOURCE, including `.blend` sources) and other packs' paid tiers
   were not verified and must not be used even if a free sibling pack is adopted.

## Rejected, and why

| Rejected | Reason |
| --- | --- |
| Minecraft / decompiled Minecraft code, textures, models | Task rule and `docs/VOXEL_ENGINE_REUSE.md`: a decompiler's licence does not license its output, and the Minecraft EULA distinguishes independent creations from Minecraft content |
| Minecraft-replica projects (e.g. MineClone/VoxeLibre, MineClone2) | Their licence may be open, but the visual identity is a Minecraft reproduction; excluded on the same grounds |
| Sword Art Online characters, textures, logos, UI naming, code | Task rule; nothing from the franchise was searched for or recorded |
| [Voxel Trees + Voxel file](https://sketchfab.com/3d-models/voxel-trees-voxel-file-variations-of-colors-7ce1a85333d945afa5c9c7cff364d38b) (Sketchfab) | CC BY-**NC-ND**: no commercial use and no derivatives, which fails both reuse and modification |
| Pixabay audio | `pixabay.com/service/license-summary/` returned HTTP 403 here, so the publisher's current terms could not be read; the Pixabay Content Licence is not CC0 and restricts standalone reuse |
| Sonniss GDC game-audio bundle | `sonniss.com/gameaudiogdc` returned HTTP 403 here; royalty-free for productions but restricts redistribution of the raw files, and the terms could not be read at the source |
| FreePD | Site announced closure; its catalogue and licence statements are no longer verifiable, which also taints tracks sourced from it |
| Unity Asset Store packs | Single-entity EULA tied to the Unity ecosystem, not a reusable open licence |
| ZapSplat and similar subscription libraries | Account-bound project use without a per-file reusable licence; does not meet the verification standard |
| Kenney "All-in-1" and "KayKit Complete" bundles | Would sweep in unrelated packs whose individual terms were not checked |
| `kenney.nl/assets/survival-kit`, `tiny-town`, `interface-sounds` | Checked (all CC0) but not shortlisted: survival-kit duplicates nature/furniture kits, tiny-town is 2D, interface-sounds is UI audio better served by RPG Audio |
| Luanti's LGPL-2.1-or-later **engine** licence as a licence for Luanti media | The engine licence covers code; `minetest_game` media is CC BY-SA 3.0 with per-file exceptions, read from its own `LICENSE.txt` |
| Terasology's Apache-2.0 **code** licence as a licence for Terasology art | The same repository states a separate, less specific artwork licence; module art without its own licence file remains unresolved |

## Unresolved rights register

Every candidate whose terms are **not** fully settled, stated without smoothing over:

1. **Terasology PlantPack** — no asset-level licence, no credits file. Do not integrate.
2. **Quaternius Ultimate Modular Men Pack** — QAL v1.0 §3a forbids reselling or redistributing the
   assets "as assets … whether for free or for payment, and whether alone or bundled with other
   assets"; it is ambiguous whether serving the model files from this app to a browser is such a
   redistribution. Older third-party lists calling Quaternius packs CC0 are **superseded** by
   QAL v1.0 ("Last updated: 8/28/2026") and no current CC0 statement could be verified. The pack
   page shows its licence only as an image, so the site-wide licence governs.
3. **KayKit packs** — CC0 is verified from the publisher's own `LICENSE.txt` in the official
   repository, but the licence file *inside the distributed archive* was not inspected (no
   download). The free/paid boundary is prose, not an itemised file list. **KayKit Forest** is
   weaker: CC0 comes only from the itch product page, with no GitHub licence-file distribution.
4. **All Kenney packs** — CC0 is stated on the publisher's own asset page and the CC0 1.0 deed is
   linked, but each archive's internal `License.txt` and file formats were not inspected. Sizes
   were measured by HTTP HEAD against the publisher's own download endpoint.
5. **minetest_game media** — CC BY-SA 3.0 is verified, but the CC BY 3.0 exception list and the
   per-mod author lists were not enumerated, and the share-alike effect on combined project
   artwork is a legal question for the owner.
6. **Terasology ChrisVolume1OST** — Apache-2.0 applies, but the module has no `NOTICE` and no
   README, so the notice obligations for the eight tracks should be confirmed with the project
   before shipping.
7. **Google Material Symbols** — the icons are Apache-2.0; the repository's font builds may carry
   their own terms, so vendor SVGs only unless the font is separately checked.
8. **game-icons.net** — CC BY 3.0 overall with **per-contributor** CC0 exceptions; each chosen
   icon's contributor entry must be read before use.
9. **Freesound Rain_Ambience** — CC0 is stated on the file's own page; downloading requires an
   account, so the page state should be captured as evidence at download time.
10. **Sizes and polycounts** — no polycount is known for any 3D pack except the OpenGameArt
    vegetation pack, and no download size is known for the KayKit, Quaternius or itch-hosted packs,
    because nothing was downloaded. These are recorded as "not published / not measured" rather
    than estimated.

## What a selection would still require

1. **Re-confirm inside the archive.** After a permitted download, read the pack's own
   `License.txt`/`LICENSE.txt` and compare it with the URL recorded in the JSON; capture the
   licence file and a hash alongside the assets, as `assets/mayors/manifest.json` already does.
2. **Decide the geometry question before any mesh pack.** The pinned bundle
   (`assets/vendor/three-voxel.js`, 551,333 bytes, hash-verified by `tests/voxel-world.test.js`)
   has no loaders. Adding one means re-bundling and re-hashing, which the engine decision record
   rejected for meshing. If that stands, the practical path is more authored cube geometry, and the
   CC0 packs remain visual references rather than imports.
3. **Keep the licence split explicit.** If a mixed set is adopted, each file's licence must survive
   into `assets/THIRD_PARTY.md` with its attribution wording (CC0 needs none; Apache-2.0 needs the
   licence text and change notices; CC BY 3.0 needs the author line; CC BY-SA 3.0 adds share-alike).
4. **Treat audio as a new subsystem.** No audio code exists; a loop, an opt-in control and a
   reduced-size re-encode (24-bit WAV and 2.4 MB MP3s are not web-delivery choices) are the real
   work, and the current CSP already permits same-origin media.
5. **Ask the owner about the repository licence.** There is no root `LICENSE` file and
   `package.json` is `private` with no licence field, so no asset licence can be inherited — this is
   the same open question recorded in `docs/CONTENT_DEFINITIONS.md`.

## Evidence index (checked 2026-10-12)

| Evidence read | URL |
| --- | --- |
| Kenney pack pages (11) and download endpoints | `https://kenney.nl/assets/<pack>` and the `media/pages/assets/...zip` link on each page |
| KayKit per-pack licences | `https://raw.githubusercontent.com/KayKit-Game-Assets/<pack>/main/LICENSE.txt` |
| KayKit product pages | `https://kaylousberg.itch.io/<pack>` |
| Quaternius licence | `https://quaternius.com/license.html` |
| OpenGameArt items | `https://opengameart.org/content/<item>` |
| Freesound sound page | `https://freesound.org/people/VanEngelen/sounds/704579/` |
| Luanti game media licence | `https://raw.githubusercontent.com/luanti-org/minetest_game/master/LICENSE.txt` |
| Terasology artwork statement | `https://github.com/MovingBlocks/Terasology/blob/develop/README.md` §License |
| Terasology music licences | `https://raw.githubusercontent.com/Terasology/<ChrisVolume1OST\|ChrisVolume2OST\|LegacyMusic>/develop/LICENSE` |
| Lucide licence | `https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE` |
| Material Design icons licence | `https://raw.githubusercontent.com/google/material-design-icons/master/LICENSE` |
| game-icons licence | `https://raw.githubusercontent.com/game-icons/icons/master/license.txt`, `https://game-icons.net/about.html` |
