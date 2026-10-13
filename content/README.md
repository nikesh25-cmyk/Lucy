# Typed content definitions

Versioned, typed definitions for blocks, furniture, crops, NPC appearances and cosmetics, each with
its own license record. This implements recommendation 3 of
[the voxel engine reuse decision](../docs/VOXEL_ENGINE_REUSE.md): a repository-wide license may
never substitute for an asset's actual terms.

The layer is self-contained. It adds no dependency, writes nothing at import time, and can be
imported by the browser client, the server and the tests alike:

```js
import { palette, color, crops, recipes, appearancesFor } from './src/content.js';
```

## Layout

```
content/
  blocks/        one JSON file per placeable voxel block      (7)
  furniture/     one JSON file per placeable world object    (27)
  crops/         one JSON file per growable crop              (3)
  appearances/   one JSON file per NPC appearance             (20)
  cosmetics/     one JSON file per cosmetic                    (32)
  palettes.json            the three authored build palettes, in their code order
  content-manifest.json    generated index: every file, digest, license and asset
  notices.json             generated map of every notice file and asset a definition references
  index.js                 generated ESM bundle for static import
  THIRD_PARTY.md           the provenance and license notice referenced by every definition
```

## Definition envelope

```jsonc
{
  "schema_version": 1,
  "id": "wood",
  "kind": "block",              // block | furniture | crop | appearance | cosmetic
  "label": "Wood",
  "since": "1.0.0",
  "order": 1,                   // resolver order within a kind; authored, not alphabetical
  "license": {                  // required on every entry
    "spdx": "LicenseRef-NemoWorld-Project-Authored",
    "author": "NemoWorld project contributors",
    "source": "…",              // the code or upstream file this value came from
    "commit": null,             // a 40 character commit id when the asset came from outside
    "notice_file": "content/THIRD_PARTY.md",
    "notice_sha256": "…",       // verified against the file by the sealer and the tests
    "note": "…"
  },
  "appearance": { "color": "#b58c58", "geometry": "cube", "transparent": false, "emissive": null },
  "rules": { "palettes": ["frontier"], "walkable": false, "stack": { "requires_solid_below": true, "z_min": 0, "z_max": 7 }, "path_only_z0": false },
  "notes": ["…"],               // optional honest engineering remarks
  "assets": [{ "path": "assets/mayors/characters/1.png", "sha256": "…" }]  // only when art is bundled
}
```

Per kind:

| kind | `rules` carries | `appearance.geometry` |
| --- | --- | --- |
| `block` | `palettes`, `walkable`, `stack` (`requires_solid_below`, `z_min`, `z_max`, `supports_stacking`), `path_only_z0` | `cube` |
| `furniture` | `palettes`, `walkable`, `footprint` (`occupied` \| `open`), `geometry` (the builder implemented in `src/voxel-world.js`) | the same builder name |
| `crop` | `grow_ms`, `yield` (`item`, `quantity`), `tile_object`, `max_growing`, `tend_saving_ms` | the tile object that hosts it |
| `appearance` | `roster_roles`, `sprite`, `directions`, `walk_rows`, `action_rows_excluded` | `sprite-sheet` |
| `cosmetic` | `cosmetic_kind`, `earned_by`, and for crafts `name`/`ingredients`/`output` | `null` (cosmetics carry data, not geometry) |

## Conventions

- **`order`** fixes the sequence a resolver returns, so a palette or roster can never be presented
  in accidental alphabetical order. `palettes.json` is the canonical order for palette membership.
- **`notes`** records what is true but not machine-checkable: which renderer draws what, and where a
  definition and the current renderer disagree. Every gap found while writing these definitions is
  written down there rather than smoothed over.
- **`assets`** lists bundled files only. The sealer verifies each declared digest against the file
  on disk and copies the verified digest into the manifest, so a wrong claim fails the seal.
- **Id space.** `id` is the game's own literal (`wood`, `herbs`, `mayor-3`, `Resident`). One id is
  shared by two kinds: `wood` is both a frontier block and a crop. `entry(id, kind)` is exact;
  `entry(id)` resolves in `CONTENT_KINDS` order (`block, furniture, crop, appearance, cosmetic`) and
  `find(id)` returns every match.
- **Palettes** are the build palettes from `src/spaces.js` (`garden`, `house`) and `src/frontier.js`
  (`frontier`). A palette id must resolve to a definition that declares that palette *and* carries a
  non-empty `license.spdx`; a definition may not claim a palette that does not list it.

## Commands

```sh
node scripts/seal-content.mjs            # re-hash entries and assets, rewrite the generated files
node scripts/seal-content.mjs --check    # verify the sealed files are current, write nothing
node --test tests/content.test.js        # licenses, hashes, palettes and the drift guards
```

The sealer is deterministic: it records no timestamps and writes with fixed key order, so sealing
twice leaves the working tree unchanged. It refuses to run when a declared digest, a notice hash or
a palette reference disagrees with the files on disk.

## What the tests enforce

- Every definition file, every referenced asset and every support file hashes to the sealed manifest.
- Every definition carries a license from an allow-list of identifiers actually evidenced here
  (`CC0-1.0` and `LicenseRef-NemoWorld-Project-Authored`), resolves its notice file on disk, and
  matches the recorded notice digest. A CC0 definition must pin a 40 character commit; a
  project-authored definition must have `commit: null` and cite `content/THIRD_PARTY.md`.
- No palette references an unknown or unlicensed id.
- `assets/manifest.json` and `assets/mayors/manifest.json` are pinned by digest *and* every file they
  list is re-hashed, so the two manifests that were previously only described in prose are now
  verified.
- Drift guards, comparing the definitions against the code they mirror: the `garden`, `house` and
  `frontier` palette literals, the voxel `COLORS` and `AGENT_COLORS` tables,
  `FRONTIER_BLOCK_COLORS`, `FRONTIER_LIMITS.maximum_z`, the journey growth times, recipes, titles and
  avatars, the runtime `EMOTES` set, the civic mayor roster, and the runtime block and crop
  allow-lists.
- The loader rejects a definition with no `license.spdx`, an unresolvable notice file, a mismatched
  notice digest, an unresolved palette id, a crop whose tile object is not furniture, and a manifest
  that does not index every definition.

## Known gaps, recorded rather than hidden

- **Voxel renderer fallbacks.** `pond`, `kitchen`, `sculpture` and `display` have dedicated cases in
  the tile renderer (`world.js`) but no dedicated builder in `src/voxel-world.js` `furniture()`, so
  they currently render through the generic prop branch (`rules.geometry: "prop"`). A `gateway`
  object draws nothing there by design: authored gateways render through the portal and gate paths.
- **Sprites 4 and 8** of the mayor pack are shipped but excluded from the roster: their sheets have
  only two rows and cannot serve four-direction walking. Recorded in the pack manifest and asserted.
- **Crop art.** The `farm` builder draws its crop dots unconditionally, so a planted crop is not yet
  distinguishable in the voxel scene; crop state is presented in the workshop UI instead.
- **Skin tones** are chosen deterministically from the agent id hash and are not operator-selectable
  today; the four tones are recorded as cosmetics with that provenance stated.
