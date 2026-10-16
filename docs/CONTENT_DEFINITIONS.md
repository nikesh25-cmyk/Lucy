# Typed content definitions

Blocks, furniture, crops, NPC appearances and cosmetics are defined once, as versioned JSON with a
per-entry license record, under `content/`. The definitions are data: `src/content.js` resolves them
for the browser, the server and the tests, and `scripts/seal-content.mjs` hashes them. This
implements recommendation 3 of [the voxel engine reuse decision](VOXEL_ENGINE_REUSE.md).

## The layer

| Kind | Entries | Files | Carries |
| --- | --- | --- | --- |
| `block` | 9 | `content/blocks/*.json` | `rules.palettes`, `walkable`, `stack` (`requires_solid_below`, `z_min`, `z_max`, `supports_stacking`), `path_only_z0`; `appearance.geometry: "cube"` |
| `furniture` | 31 | `content/furniture/*.json` | `rules.palettes`, `walkable`, `footprint` (`occupied`/`open`), `rules.geometry` (the builder name implemented in `src/voxel-world.js`) |
| `crop` | 6 | `content/crops/*.json` | `rules.grow_ms`, `yield` (`item`, `quantity`), `tile_object`, `max_growing`, `tend_saving_ms` |
| `appearance` | 20 | `content/appearances/*.json` | `rules.roster_roles`, `sprite`, `directions`, `walk_rows`, `action_rows_excluded`; CC0-1.0 art |
| `cosmetic` | 32 | `content/cosmetics/*.json` | `rules.cosmetic_kind`, `earned_by`, and for crafts `name`/`ingredients`/`output` |
| `place` | 6 | `content/places/*.json` | `rules.family`, `site` (the grid, arrival, portal, plaza band and the venue machinery reused), `structure`, and the fixtures, activities, residents and ambient profile it wires |
| `fixture` | 12 | `content/fixtures/*.json` | `rules.family`, `object` (a sealed furniture id), `footprint`, `scenery_class`, `blocks_route`, `arrangement`, `tiles`, `owner`, `placement`, `provenance` |
| `activity` | 8 | `content/activities/*.json` | `rules.family`, `place`, `residents`, `participants`, `cadence`, `duration_ticks`, `relates_to`, `motion`, `reduced_motion`, `clock`, `implements` |
| `resident` | 6 | `content/residents/*.json` | `rules.family`, `place`, `role`, `appearance` (a sealed appearance id), `schedule`, `dialogue_topics`, `remit`, `independence` |
| `ambient` | 6 | `content/ambient/*.json` | `rules.family`, `place`, `profile`, `time_of_day`, `layers`, `motion`, `reduced_motion`, `provenance` |

`content/content-manifest.json` indexes all **136** entries (9 + 31 + 6 + 20 + 32 + 6 + 12 + 8 + 6 + 6)
by file, digest, license and asset. The counts above, the manifest and the drift guards are recomputed
and asserted by `tests/content.test.js`, so this table cannot silently diverge from the definitions.

The last five kinds are the authored content families added by
[the content manifest slice](CONTENT_MANIFEST.md). None of them draws new geometry: a fixture repeats
the sealed furniture builder in `appearance.geometry` and a resident repeats a sealed appearance id,
so neither can introduce an asset. Their rules — reference resolution, footprint and collision,
accessibility, determinism and independence — live in `src/content-manifest.js` and are described
there.

The six crops are one family that shares one garden cap and one five-minute tend, and differs in
everything a resident chooses between: growth time, harvest amount and the care window that decides
how much a tend is worth. `herbs` (20 min, 2), `fiber` (25 min, 2), `wood` (30 min, 2), `blossom`
(15 min, 3), `grain` (40 min, 4) and `resin` (50 min, 1). Because the care bands divide each crop's
own growth, the same elapsed tend time is *bountiful* for a slow crop and merely *careful* for a
quick one — `tests/journey-content.test.js` asserts exactly that pair.

The frontier palette gained `clay` and `slate`, and the garden palette gained `well`, `birdbath`,
`sundial` and `millstone` (the last two are also on the cottage palette). No list of block or object
types is hand-maintained: `src/frontier.js` derives `FRONTIER_PALETTE`, its table `CHECK` clause and
the plot-grant scope test from `content.palette('frontier')`, `src/placement-policy.js` derives both
build palettes, and `src/footprints.js` classifies each one. Adding a definition to a palette
therefore makes it buildable, grantable and storable without a second copy of the list.

Two content files are deliberately **not** touched by an additive change: `content/THIRD_PARTY.md`
is the shared notice file whose SHA-256 every definition records, so editing it would change all 136
`license.notice_sha256` values (including the frozen appearance and cosmetic entries); its per-group
counts are therefore descriptive, and the executable counts are the ones in `tests/content.test.js`.

Support files: `content/palettes.json` (the three authored build palettes in code order — `garden`
and `house` from `src/spaces.js`, `frontier` from `src/frontier.js`), `content/notices.json` (every
notice file and asset a definition references), `content/index.js` (a generated ESM bundle for static
import) and `content/THIRD_PARTY.md` (the provenance and license notice referenced by every
definition). The full envelope and the per-kind rules table are documented in
[`content/README.md`](../content/README.md), which also lists the five authored families.

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
  "kinds": { "activity": 8, "ambient": 6, "appearance": 20, "block": 9, "cosmetic": 32, "crop": 6, "fixture": 12, "furniture": 31, "place": 6, "resident": 6 },
  "entries": [{ "id": "…", "kind": "…", "file": "content/…", "sha256": "…", "license": { "…": "…" }, "assets": [] }],
  "support": [{ "path": "content/palettes.json", "sha256": "…" }, { "path": "content/notices.json", "sha256": "…" }, { "path": "content/index.js", "sha256": "…" }]
}
```

Each definition file, `content/index.js` and `content/content-manifest.json` are also served as
static browser modules, so the client module graph can import `src/content.js` directly.

## Authored content families

Five kinds were added on top of the artwork vocabulary — `place`, `fixture`, `activity`, `resident`
and `ambient`. They carry no new art and no new geometry: a place reuses an existing venue builder in
`world.js`, a fixture repeats a sealed furniture builder, and a resident repeats a sealed appearance
id. Their schema, their validator and every refusal rule are in
[the content manifest slice](CONTENT_MANIFEST.md); the definitions themselves are sealed exactly like
the artwork ones, so this page's counts include them.

## Known gaps, recorded rather than hidden

The four renderer, sprite, crop-art and skin-tone gaps are recorded with the definitions in
[`content/README.md`](../content/README.md). Two further gaps found while adding the authored
families are reproduced by `node --test tests/framework/known-gaps-content.mjs` — a file bare
`node --test` does not collect, so `npm test` stays green while each stays reproducible, with its
command, invariant, observation and owner recorded in the file:

- a seventh crop definition would fork the persisted `journey_crops` schema silently, because the
  table's `CHECK` clause is derived from the sealed crop list while `PRAGMA user_version` stays 25
  (owner: persistence/schema owner; the fix is a migration);
- the sealed furniture rules and the shared footprint table in `src/footprints.js` disagree for 18 of
  31 furniture definitions, and nothing compares them (owner: content/runtime owner).
