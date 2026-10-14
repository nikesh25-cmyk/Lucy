# Resident art set: licence and provenance

Two CC0 1.0 Universal pixel-art sets, staged on 14 October 2026 so that every resident named in the
interface has a face and a standing figure. `manifest.json` is the machine-readable record: per file
its source pack, source path, SHA-256, byte size, pixel dimensions and — for a cropped face — the
exact source rectangle. This file is the human-readable half of the same record.

| Set | Files | What it is | Author | Licence |
| --- | --- | --- | --- | --- |
| `faces/` | 27 | 32 × 32 portrait busts, 9 heads in 3 colour palettes | Buch | CC0-1.0 |
| `bodies/` | 10 | 16 × 16 transparent-background standing figures | Kenney (kenney.nl) | CC0-1.0 |

## `faces/` — Buch, "RPG portraits"

| Fact | Recorded value |
| --- | --- |
| Licence | `CC0-1.0` (CC0 1.0 Universal) |
| Author | Buch |
| Source page | `https://opengameart.org/content/rpg-portraits` (OpenGameArt, published 14 October 2014) |
| Source file | `https://opengameart.org/sites/default/files/rpgportraits.png` |
| Source SHA-256 | `234ccba32fcc80dbea00e6257dc29127d0e2e0f89f0336eb5c1ff691bacc4ff1` (21,125 bytes, 328 × 112) |
| Author's notice | "NOT REQUIRED, though appreciated: credit me as Buch and link back either to my OGA profile page or to http://blog-buch.rhcloud.com" |
| Modification | Lossless crop. Each staged file is one 32 × 32 cell of the source sheet, copied pixel for pixel: no resampling, no recolouring, nothing drawn or removed. The grid is cell 32 × 32 at origin (4, 4) with a stride of 36 px in both directions; `faces/NN.png` is row-major, `id = row * 9 + column + 1`. |

The pack's own description is "9 32x32 portraits in 3 color variations each" — 9 faces, each repeated
in three palettes, which is where the 27 files come from. Attribution is not required by CC0; the
author is credited here and in [`../THIRD_PARTY.md`](../THIRD_PARTY.md) because the author asked for it.

## `bodies/` — Kenney, "Tiny Dungeon"

| Fact | Recorded value |
| --- | --- |
| Licence | `CC0-1.0` (CC0 1.0 Universal) |
| Author | Kenney (kenney.nl) |
| Source page | `https://kenney.nl/assets/tiny-dungeon` |
| Source archive | `https://kenney.nl/media/pages/assets/tiny-dungeon/f8422efb44-1674742415/kenney_tiny-dungeon.zip` |
| Archive SHA-256 | `c109438ab06f65fd80f9b2686a4cf9c7c11dc64444b47333ec71d602f8bb5fc7` (98,530 bytes) |
| Pack notice | [`licenses/kenney-tiny-dungeon-License.txt`](licenses/kenney-tiny-dungeon-License.txt), SHA-256 `9f574a2f1f636a3db8a0665ba90212f34e2b5e61ecb533d77c05237766374111` |
| Modification | None. Each staged file is one `Tiles/tile_XXXX.png` from the pack, byte for byte, with its own SHA-256 recorded in the manifest. |

The ten figures are the pack's person tiles — `tile_0084`–`tile_0088` and `tile_0096`–`tile_0100`.
The pack's other tiles are terrain, furniture, weapons, potions and monsters and are **not** staged:
this set adds no dungeon furniture and no monster to the world. Each figure is a transparent-background
16 × 16 sprite drawn front-facing, the same pixel grammar the world's own 16 px characters use.

## How the interface uses the set

`app.js` resolves one face and one figure per resident from the resident's own stored id, so the same
resident shows the same art in every layer — the profile card, the resident roster, the civic and
ambassador views and the first-play guide. The mapping is a stable hash of the id over the 27 face ids
and over the 10 figure ids; it reads no name, no operator and no other private field, and it is
computed in the browser with no request. Nothing here is sealed content: the civic roster's own CC0
appearance sheets under [`../mayors/`](../mayors/) remain the ambassadors' art, and this set is
separate from them.

## Rights, honestly

- Both sets are CC0 1.0 Universal, so redistribution and modification need no permission. The credits
  above are good practice, not a condition.
- The `faces/` files are **derived** files: a crop of a third-party sheet. The crop is lossless and
  pinned by SHA-256 in the manifest, and the source sheet and its digest are recorded above so the
  derivation can be checked or repeated.
- Nothing here is legal advice; it records what was verified from the file actually downloaded.
- No asset in this directory was traced from, or substitutes for, Minecraft, Luanti or Terasology art.
