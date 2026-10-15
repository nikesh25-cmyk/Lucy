# Scalable world content and the safe authoring path

Five authored content families — **places, fixtures, activities, residents and ambient details** — a
schema and a callable validator for them, and a preview/publication path that validates first and then
either writes nothing or writes atomically and reversibly.

The whole slice is **declarative**: it adds no renderer geometry, no third-party asset and no schema
change. A place names the venue machinery it reuses; a fixture names the sealed furniture builder it
draws; a resident names a sealed appearance. `src/voxel-world.js`, `app.js`, `src/scene/*`,
`src/database.js`, `src/recovery.js` and `src/spaces.js` are untouched, and the database schema is
unchanged at 25.

- Module: `src/content-manifest.js` — the schema, the rules and `validateContentManifest` /
  `validateContentFamilies`. Pure: no file system, no DOM, no clock.
- Definitions: `content/places|fixtures|activities|residents|ambient/*.json`, sealed by the existing
  `scripts/seal-content.mjs`.
- Publication: `scripts/content-publish.mjs` — preview (default), `--publish`, `--rollback`.
- Tests: `tests/content-manifest.test.js`, `tests/content-publish.test.js`,
  `tests/content-determinism.test.js`, and `tests/framework/known-gaps-content.mjs` (deliberately
  failing, never loaded by `npm test`).

## The sealed corpus

| kind | family directory | count | what it carries |
| --- | --- | ---: | --- |
| `place` | `content/places/` | 6 | the site it occupies, the structure it authors, and the fixtures, activities, residents and ambient profile it wires |
| `fixture` | `content/fixtures/` | 12 | one sealed furniture id, the arrangement, the absolute tiles, and the place that owns it |
| `activity` | `content/activities/` | 8 | a deterministic tick schedule and the sealed ids it concerns |
| `resident` | `content/residents/` | 6 | a role, a sealed appearance id, an authored slot list and a remit |
| `ambient` | `content/ambient/` | 6 | an ordered tick window and coloured layers |

That is **31 authored definitions on top of the 129 artwork definitions**, for **136** in the sealed
manifest (`8 activity, 6 ambient, 20 appearance, 9 block, 32 cosmetic, 6 crop, 12 fixture, 31
furniture, 6 place, 6 resident`). `node scripts/seal-content.mjs --check` prints those numbers, and
`tests/content.test.js` asserts them, so this table cannot drift.

`src/content.js` gained the five kinds, **appended after the shipped five** so that `entry(id)`
without a kind resolves an ambiguous id exactly as it did before. `CONTENT_KINDS` is now ten long;
`wood` is still the only id two shipped kinds share.

## The schema and every refusal rule

`validateContentManifest(manifest, options)` validates one family document.
`validateContentFamilies(bundle, options)` validates every authored family in a sealed bundle and the
collisions between them; it requires a resolver, because a bundle check without one would silently
skip every reference. Neither throws for a content problem: they collect refusals and return them, so
a preview shows **all** the reasons at once.

Every refusal carries the category, the concrete rule, the field path, what was found, and — where
the rule comes from an existing project document — the citation:

```
accessibility [hit-target] — places/bad-venue/rules.accessibility.hit_target_px:
  hit target 32 is below the 44 px floor
  source: the 44-pixel control floor stated and measured in docs/MOBILE_ACCESSIBILITY.md and
          asserted by tests/mobile-styles.test.js
```

| code | refused when | named rules |
| --- | --- | --- |
| `unknown-family` | the manifest claims a family outside the five | — |
| `schema-version` | the manifest or an entry declares a version the validator does not speak | — |
| `missing-field` | a field the family requires is absent or empty | — |
| `malformed-field` | a field is the wrong type, shape or range | `count-matches-tiles`, `sealed-furniture-geometry` |
| `missing-license` | no usable licence record, an identifier outside the two evidenced ones, an unresolvable notice file, or a notice digest that disagrees with the seal | — |
| `missing-provenance` | no licence note, no source, a CC0 value with no pinned commit, project-authored work with a commit, or no `rules.provenance.derived_from` | — |
| `unresolved-reference` | a cross-family reference names an id that resolves to nothing or to the wrong kind | — |
| `duplicate-id` | one kind and id appears twice in a manifest, in a reference list or in an ambient layer | — |
| `id-collision` | an authored id already belongs to another kind, or a reference resolves to more than one kind | — |
| `footprint-collision` | a fixture's footprint or scenery class disagrees with `src/footprints.js`; a tile is out of the site, doubles up, sits on the arrival or the portal, sits on a declared water tile without `placement.on: water`, blocks the public approach, or sits inside a country venue's walkable plaza band; a place's grid, arrival or portal disagrees with the live world; a tile is held by a saved plot or block column; or a shared place claims to register land | `shared-footprint-table`, `sealed-furniture-rule`, `site-bounds`, `plaza-band-clear`, `approach-blocked`, `water-occupied`, `mooring-not-on-water`, `saved-land`, `live-world-shape`, `live-arrival`, `live-portal`, `self-overlap` |
| `accessibility` | a declared value is below the bar this repository already enforces, or a route is unreachable | `contrast-text`, `contrast-nontext`, `hit-target`, `layout-390`, `reduced-motion`, `walkable-route` |
| `nondeterminism` | a clock-reading key, a date value, an epoch value, a generated id, a generator call, a slot list that does not increase, a cadence jitter with no authored source, a non-authored ordering, or a shared `order` | `no-clock-field`, `no-date-value`, `no-epoch-value`, `no-generated-id`, `no-generator-call`, `ordered-slots`, `authored-jitter`, `authored-order`, `order-tiebreak` |
| `independence-claim` | `fictional` is not true, `claims_endorsement` / `government_role` / `un_role` is not false, the disclaimer is absent or vacuous, or any label, note or remit asserts endorsement, representation or official status | `non-vacuous-disclaimer`, `no-endorsement-claim` |

### Accessibility, named concretely

| rule | enforced value | source in this repository |
| --- | --- | --- |
| `hit-target` | ≥ 44 px | the control floor quoted and measured on every mobile control (`docs/MOBILE_ACCESSIBILITY.md`, `tests/mobile-styles.test.js`) |
| `layout-390` | viewport ≥ 390 px | the phone width the atlas, the globe and the mobile layer must reflow to (`docs/COUNTRY_ATLAS.md`, `docs/COUNTRY_GLOBE.md`, `docs/MOBILE_ACCESSIBILITY.md`) |
| `contrast-text` | measured ratio ≥ 4.5:1 | WCAG 2.1 AA 1.4.3, as measured in `tests/mobile-styles.test.js`. The validator computes the ratio itself from the declared `#rrggbb` pair — it never trusts the number in the manifest |
| `contrast-nontext` | measured ratio ≥ 3:1 | WCAG 2.1 AA 1.4.11, the bar the focus ring and key edge are held to |
| `reduced-motion` | a profile that moves must state `equivalent-still`; one that does not move must state `not-needed` | animation is opt-in under `prefers-reduced-motion: no-preference` and every animated declaration has a suppression (`docs/MOBILE_ACCESSIBILITY.md`, `docs/CONTROLS.md`) |
| `walkable-route` | a country venue and a public venue plan return from their own arrival; a district returns from its south edge, as `makeDistrict` roads it | `world.js` `countryApproach` / `countryScenery`, asserted by `tests/country-venues.test.js` |

A manifest that *relaxes* one of these is refused as well as one that fails it: declaring
`target: 3` for a text pair is a `contrast-text` refusal even when the colours themselves measure
above 4.5:1.

### Determinism, named concretely

Three distinct hazards, each with its own rule:

1. **A clock or a generator.** A `timestamp`, `created_at`, `now`, `date`, `seed`, `random` or `uuid`
   key inside `rules`; an ISO-8601 date; a value in the millisecond-epoch range; a 32-hex or UUID
   literal; or a string naming `Math.random`, `Date.now` or `randomUUID`.
2. **An iteration order.** A resident's or activity's slot list that does not strictly increase, and a
   cadence `jitter` above zero with no `jitter_source` naming the authored input it comes from.
3. **A locale-dependent tiebreak.** Two definitions of one family may not share an `order`. The
   resolver in `src/content.js` breaks that tie with `String.prototype.localeCompare`, whose result
   depends on the collation the runtime was built with — `ängel` sorts before `zulu` under an English
   collation and after it under a Swedish one. `tests/content-manifest.test.js` demonstrates that
   divergence with `Intl.Collator` and then asserts the refusal, so the rule is not a hypothesis.

## Preview and publication

`scripts/content-publish.mjs` reads a staging directory shaped like `content/`
(`content-incoming/` by default):

```sh
node scripts/content-publish.mjs                     # preview: the default, writes nothing anywhere
node scripts/content-publish.mjs --publish           # apply, reseal, verify
node scripts/content-publish.mjs --rollback          # undo the last publication
node scripts/content-publish.mjs --from DIR --json   # a staging directory, and a machine-readable report
node scripts/content-publish.mjs --land land.json    # saved tiles a place or fixture may not take
```

**How they differ.** Preview is not a weaker check. Both run the same validator over the same proposed
bundle, and both **seal a mirror** of `content/` with the staged files applied, using the real
`scripts/seal-content.mjs`, and read the three generated documents back. Preview then stops and
reports; publication writes the staged files, reruns the sealer, runs `--check`, and compares the tree
it produced against the previewed mirror — if the two disagree, the publication is rolled back and
reported. The only difference between the two modes is whether files are moved.

**What "atomic and reversible" means here, precisely.** Every destination path the run will touch,
plus the three generated documents, is recorded with its current bytes in
`<staging>/.publish-journal.json` *before* the first file is moved. Either every staged file lands and
the seal verifies, or a failure — including a verification mismatch — restores every touched path from
the journal and reseals. It is **not** a single filesystem rename, and the window between the first
move and the verification is real; the journal is what closes it. The journal is kept after a
successful publication, so the last publication can be undone with `--rollback` until the next
publication replaces it.

**Refusals write nothing.** A staged set with any refusal exits non-zero, prints every refusal with
its rule, and never reaches the writing step — the generated documents are not even computed, and the
report says so.

## The country-venue and regional experiences

Six places, each of which **reuses existing venue machinery** and states which in
`rules.site.machinery`:

| place | site kind | reuses | structure kind |
| --- | --- | --- | --- |
| `terrace-flight-venue` | `country-variant` | `world.js` `makeCountry('NPL')` with `COUNTRY_VENUE_ASSIGNMENT.NPL === 'terraces'` | `terrace-flight` |
| `grove-ring-venue` | `country-variant` | `makeCountry('KEN')` with `'kaya'` | `grove-ring` |
| `channel-landing-venue` | `country-variant` | `makeCountry('MEX')` with `'chinampas'` | `channel-network` |
| `mosaic-field-venue` | `country-variant` | `makeCountry('JPN')` with `'satoyama'` | `field-mosaic` |
| `coast-landing-district` | `district` | `makeDistrict('district:coast')` over `src/civic.js` `REGIONS` | `road-and-plaza` |
| `amphitheatre-precinct` | `venue-plan` | `PUBLIC_VENUE_PLANS` / `makePublicVenue('venue:amphitheatre')`, `VENUE_COLUMNS` 30 × `VENUE_ROWS` 22 | `bowl-and-ring` |

**What makes them genuinely distinct, and not one template repeated.** They differ in *site kind*
(country venue, regional district, commons venue plan), in *grid* (40 × 28, 48 × 36, 30 × 22), in
*terrain vocabulary* (meadow/path/farm/plaza; meadow/garden/path/plaza; meadow/farm/water/bridge/path/
plaza; meadow/water/path/plaza; meadow/garden/plaza/rug/path), in *structure kind* — all six
different — in whether they declare water and how (`channels` at x = 30–31 and y = 17 for the channel
landing; a `shore` strip below x = 5 for the coast district; none for the other four) — and in the
whole family set they wire. `tests/content-manifest.test.js` asserts pairwise-distinct signatures and
six distinct structure kinds, and each place's declared grid, arrival and portal are asserted equal to
the live world's, so a place cannot quietly republish a different shape.

A structural difference that matters in practice: `band_rule` is `clear-of-mass` for a country venue,
whose `world.js` machinery paints its 16 × 16 plaza band last and keeps it free of solid scenery, and
`none` for a district, whose `makeDistrict` paints its plaza under its own lanterns. The validator
enforces the band rule for a mass fixture and does not for a flat or a frame, so the same
`open-shelter` **may** stand in the band while a bench may not.

**Independence.** Every place and every resident carries an explicit `independence` record
(`fictional: true`, `claims_endorsement: false`, `government_role: false`, `un_role: false`) and a
non-vacuous disclaimer naming government, ministry, embassy and the United Nations as things the
space is **not**. The validator additionally scans every label, note, remit, machinery string and
reuse note for endorsement, accreditation or official-status language, and refuses it. The disclaimer
itself is the one field exempt from that scan, and only because it is required to negate an
institution. Nothing in this slice claims institutional endorsement or real-world adoption.

## The determinism proof

`tests/content-determinism.test.js` proves the property the brief names: **an old saved world reopens
correctly after a content update.**

It saves real material into a fixture database — four garden placements, two plantings, two shelf
entries, a stewarded plot and two frontier block columns, through the product's own methods and the
storage triggers derived from the sealed content — then digests every row of `worlds`,
`world_objects`, `frontier_sectors`, `frontier_blocks`, `land_parcels`, `land_stewardships`,
`land_events`, `plot_grants`, `journey_crops` and `journey_inventory`. It then performs a real
content update: a **mirror** of `content/` gets two new definitions and the authored `order` of every
furniture and block definition reversed, is sealed by the real sealer, and is loaded back with the
real resolver. It asserts that:

- the reorder really took effect (the presented furniture sequence changed);
- every saved row is byte-identical — nothing moved;
- every stored placement, block and crop id still resolves to the same kind, colour and builder, and
  the list of resources a saved shelf can hold is unchanged;
- every generated world shape and every piece of content-derived SQL (`WORLD_OBJECT_GUARDS`,
  `FRONTIER_SCHEMA`, `JOURNEY_SCHEMA`, the four palettes) is identical;
- every definition the update did not touch re-seals to a byte-identical digest, and the ones that
  merely changed `order` keep their licence, appearance and rules exactly.

Two negative controls draw the boundary: **removing** a definition a save references makes it stop
resolving (so the update must be additive), and a **cross-kind id collision** is refused by the
validator even though the bare resolver tolerates it and answers the ambiguous lookup in kind order.
A third test records a different class of change: adding a definition **to a palette** rewrites the
guard SQL a database was created with, which is a schema-shaped change and is not shipped silently —
see the first known gap below.

## Known gaps, recorded rather than hidden

`tests/framework/known-gaps-content.mjs` holds two deliberately failing repros, in a file bare
`node --test` does not collect so that `npm test` stays green:

```sh
node --test tests/framework/known-gaps-content.mjs
```

1. **A seventh crop definition forks the persisted schema silently.** `src/journey.js` builds
   `journey_crops.kind` as `CHECK(kind IN (…the sealed crop ids…))` at load time, and the table is
   `CREATE TABLE IF NOT EXISTS`. Adding a crop therefore changes the schema a *fresh* database is
   created with while an existing one keeps the clause it has — and both report `PRAGMA user_version`
   25, which `RECOVERY_LIMITS.accepted_schema_versions` accepts, so `validateDatabase()` cannot tell
   them apart and a planting of the new kind fails on the old database with a raw SQLite CHECK error.
   Owner: persistence/schema owner. The fix is a migration, which this slice may not write.
2. **The sealed furniture rules and the shared footprint table disagree for 18 of 31 furniture
   definitions.** `src/footprints.js` calls itself "One source of truth for what stands where" and is
   what server movement, pathfinding, placement validation and the renderer all read; 18 sealed
   definitions declare `walkable: true` / `footprint: "open"` for types that table classes as a
   blocking `mass`. No check compares them. Owner: content/runtime owner. Not fixed here because
   either repair changes runtime behaviour beyond this slice.

## What this slice did not do

- No new renderer geometry and no new asset. Places reuse the venue builders, fixtures reuse sealed
  furniture builders, residents reuse sealed appearances.
- No schema change, no migration, no new schema version. The database is still version 25.
- No change to `app.js`, `src/voxel-world.js`, `src/scene/*`, `src/database.js`, `src/recovery.js` or
  `src/spaces.js`.
- No palette was widened, and `content/THIRD_PARTY.md` was not edited: widening either would change
  derived SQL or every definition's notice digest.
- An activity records the schedule the living-world loop is *expected* to keep. It is not yet read by
  `src/living-world.js`; each definition says so in `rules.implements`.
