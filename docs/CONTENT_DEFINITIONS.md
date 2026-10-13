# Typed content definitions

Blocks, furniture, crops, NPC appearances and cosmetics are defined once, as versioned JSON with a
per-entry license record, under `content/`. The definitions are data: `src/content.js` resolves them
for the browser, the server and the tests, and `scripts/seal-content.mjs` hashes them. This
implements recommendation 3 of [the voxel engine reuse decision](VOXEL_ENGINE_REUSE.md).

## The layer

| Kind | Entries | Files | Carries |
| --- | --- | --- | --- |
| `block` | 7 | `content/blocks/*.json` | `rules.palettes`, `walkable`, `stack` (`requires_solid_below`, `z_min`, `z_max`, `supports_stacking`), `path_only_z0`; `appearance.geometry: "cube"` |
| `furniture` | 27 | `content/furniture/*.json` | `rules.palettes`, `walkable`, `footprint` (`occupied`/`open`), `rules.geometry` (the builder name implemented in `src/voxel-world.js`) |
| `crop` | 3 | `content/crops/*.json` | `rules.grow_ms`, `yield` (`item`, `quantity`), `tile_object`, `max_growing`, `tend_saving_ms` |
| `appearance` | 20 | `content/appearances/*.json` | `rules.roster_roles`, `sprite`, `directions`, `walk_rows`, `action_rows_excluded`; CC0-1.0 art |
| `cosmetic` | 32 | `content/cosmetics/*.json` | `rules.cosmetic_kind`, `earned_by`, and for crafts `name`/`ingredients`/`output` |

`content/content-manifest.json` indexes all **89** entries (7 + 27 + 3 + 20 + 32) by file, digest,
license and asset. The counts above, the manifest and the drift guards are recomputed and asserted
by `tests/content.test.js`, so this table cannot silently diverge from the definitions.

Support files: `content/palettes.json` (the three authored build palettes in code order — `garden`
and `house` from `src/spaces.js`, `frontier` from `src/frontier.js`), `content/notices.json` (every
notice file and asset a definition references), `content/index.js` (a generated ESM bundle for static
import) and `content/THIRD_PARTY.md` (the provenance and license notice referenced by every
definition). The full envelope and the per-kind rules table are documented in
[`content/README.md`](../content/README.md) (read-only; not edited by the docs layer).

## Provenance and licenses

**The repository has no root `LICENSE`, `COPYING` or `LICENCE` file**, and `package.json` declares
`"private": true` with no `license` field. There is therefore no repository-wide license a consumer
could rely on. Each definition records its own terms, and the loader rejects one whose
`license.notice_file` or `notice_sha256` does not resolve on disk. Only two identifiers are allowed:

- `LicenseRef-NemoWorld-Project-Authored` — original project work (blocks, furniture, crops,
  cosmetics and the wiring). `commit` must be `null` and the notice file is `content/THIRD_PARTY.md`.
  It is deliberately not `MIT`, not the Three.js license and not any bundled font or icon license.
- `CC0-1.0` — the 20 appearance entries, which are the only third-party art in the layer: the civic
  mayor character sheets and facesets from Pixel-boy / Sparklin Labs, used verbatim from a CC0 pack
  at pinned commit `e8674a03ab4456802f71f848c4df79eccca23f7a`. A CC0 definition must pin a 40-character
  commit and list its asset files with SHA-256 digests.

Three.js is a renderer dependency traced in `assets/vendor/three-source-manifest.json`, not a
content asset; its MIT license does not apply to these definitions. No Minecraft, Luanti, Terasology
or other engine asset, model or texture is included.

## Resolver and tooling

```js
import { palette, color, crops, recipes, appearancesFor } from './src/content.js';
```

`src/content.js` validates the bundle at load (`validateBundle`) and exposes `entry(id, kind)`,
`find(id)` (every kind that shares an id — only `wood` is both a frontier block and a crop),
`entries(kind)`, `licenses()`, `assets(id, kind)`, `palettes()`, `palette(name)`, `color`, `geometry`,
`crops()`, `recipes()`, `cosmetics(kind)`, `appearancesFor(role)`, `rules(kind)` and `manifest()`.
Ordering comes from the authored `order` field, not alphabetical sort.

```sh
node scripts/seal-content.mjs            # re-hash entries and assets, rewrite the generated files
node scripts/seal-content.mjs --check    # verify the sealed files are current, write nothing
node --test tests/content.test.js        # licenses, hashes, palettes and the drift guards
```

The sealer records no timestamps and writes with fixed key order, so sealing twice leaves the working
tree unchanged, and it refuses to run when a declared digest, notice hash or palette reference
disagrees with the files on disk.

## Read route

`GET /api/v1/content` is public and read-only (it is in the GET allow-list and the public-route list
in `server.js`; a POST returns 405). It returns the sealed `content/content-manifest.json` verbatim —
the same object as `manifest()`:

```json
{
  "schema_version": 1,
  "generated_by": "scripts/seal-content.mjs",
  "kinds": { "appearance": 20, "block": 7, "cosmetic": 32, "crop": 3, "furniture": 27 },
  "entries": [{ "id": "…", "kind": "…", "file": "content/…", "sha256": "…", "license": { "…": "…" }, "assets": [] }],
  "support": [{ "path": "content/palettes.json", "sha256": "…" }, { "path": "content/notices.json", "sha256": "…" }, { "path": "content/index.js", "sha256": "…" }]
}
```

Each definition file, `content/index.js` and `content/content-manifest.json` are also served as
static browser modules, so the client module graph can import `src/content.js` directly.
