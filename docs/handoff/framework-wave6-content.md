# Wave 6 — scalable world content and a safe authoring path

Handoff for the Wave 6 content slice of NemoWorld.

- Branch: `framework-wave6-content`
- Worktree: `/Users/nikesh/Documents/Codex/2026-10-15/nemoworld-framework/work/wave6`
- Base commit: `27c0d72` ("feat: seed circles, gatherings and a guild project through the living residents"), schema 25
- Tip commit: this handoff commit, whose parent is `80353a4` (the last implementation commit).
  `git rev-parse framework-wave6-content` gives the branch head exactly; the SHA of the handoff commit
  is not written here because writing it would change it.
- Schema: **unchanged at 25** — no migration, no new table, no new column, no new schema version
- Node: `v24.15.0`

## 1. What this delivers, in one paragraph

Five authored content families — **places, fixtures, activities, residents and ambient details** —
are added to the sealed content layer in the existing `content/**` envelope, rather than in a parallel
format. A pure module, `src/content-manifest.js`, is the schema and the callable validator for them:
every failure is a named reason with the concrete rule, the field path and, where the rule comes from
an existing project document, the citation. A new script, `scripts/content-publish.mjs`, validates a
staged set and then either writes nothing (preview, the default) or publishes atomically and
reversibly, always leaving the sealed manifest produced by the sealer. Six country-venue and regional
experiences are authored as content that reuses existing venue machinery and states which. The
property the brief names — an old saved world reopens correctly after a content update — is proved
against a real fixture database and a really resealed mirror of the content layer. Nothing in the
slice adds renderer geometry, a third-party asset, a schema change or a new dependency.

## 2. Changed files

`git diff --stat 27c0d72 HEAD` on the shipped tip: **54 files changed, 6,294 insertions, 122
deletions**, in **8 commits**.

| File | Change | Why |
| --- | --- | --- |
| `content/places/*.json` | **new**, 6 files | The authored places: four country-variant venues, one regional district, one commons venue plan |
| `content/fixtures/*.json` | **new**, 12 files | Arrangements of a sealed furniture builder placed on named tiles of one place |
| `content/activities/*.json` | **new**, 8 files | Deterministic tick schedules and the sealed ids each one concerns |
| `content/residents/*.json` | **new**, 6 files | Fictional hosts: a role, a sealed appearance, an authored slot list, a remit, an independence record |
| `content/ambient/*.json` | **new**, 6 files | Ordered tick windows and coloured layers, with a stated reduced-motion equivalent |
| `content/content-manifest.json` | regenerated | 136 definitions instead of 98; produced by the sealer |
| `content/index.js` | regenerated | the 31 new definitions added to the static import bundle |
| `content/notices.json` | unchanged (regenerated, byte-identical) | the new definitions cite existing notice files and bundle no asset, so the notice map does not move |
| `content/README.md` | +46 / −5 | the five family directories (its block/furniture/crop counts were also stale), the new kinds in the envelope table, the publication commands |
| `scripts/seal-content.mjs` | +48 / −1 | learns the five family directories, checks `rules.family`, resolves every cross-family reference to the kind it promises |
| `src/content.js` | +32 / −1 | appends the five kinds after the shipped five, exports the family map, checks each family envelope |
| `src/content-manifest.js` | **new**, 704 lines | the schema, the rules and `validateContentManifest` / `validateContentFamilies`; pure, no fs, no DOM, no clock |
| `scripts/content-publish.mjs` | **new**, 321 lines | the preview/publication/rollback path |
| `tests/content.test.js` | +4 / −3 | reports the new composition (136 definitions, ten kinds) |
| `tests/world-places.test.js` | +9 / −4 | reports the new composition and asserts the five shipped artwork families are unchanged by this slice |
| `tests/content-manifest.test.js` | **new**, 348 lines, 12 tests | every refusal code reached from a real manifest; the accessibility sources; the locale tiebreak |
| `tests/content-publish.test.js` | **new**, 187 lines, 5 tests | preview writes nothing; a refused set writes nothing; publish + `--check`; rollback restores byte for byte |
| `tests/content-determinism.test.js` | **new**, 281 lines, 3 tests | the determinism proof and its two negative controls |
| `tests/framework/known-gaps-content.mjs` | **new**, 171 lines, 2 deliberately failing repros | a file bare `node --test` does not collect |
| `docs/CONTENT_MANIFEST.md` | **new**, 239 lines |
| `docs/CONTENT_DEFINITIONS.md` | +18 / −5 | the five authored kinds in its layer table, the composition in prose and in the `/api/v1/content` example, and the two new known gaps with their owners | the five families, every refusal, the accessibility sources, preview vs publication, the determinism proof, the known gaps |

Files this slice did **not** touch: `app.js`, `src/voxel-world.js`, `src/scene/*`, `src/database.js`,
`src/recovery.js`, `src/spaces.js`, `world.js`, `src/footprints.js`, `src/placement-policy.js`,
`src/frontier.js`, `src/journey.js`, `server.js`, `.github/workflows/ci.yml`, `docs/OPERATIONS.md`,
`docs/PERFORMANCE.md`, `docs/FRESH_INSTALL_REHEARSAL_REPORT.md`, `docs/CI_GATE_REPRODUCTION.md`,
`content/palettes.json` and `content/THIRD_PARTY.md`.

## 3. Exact modules and routes extended

- **`src/content.js`** — `CONTENT_KINDS` is now `['block','furniture','crop','appearance','cosmetic','place','fixture','activity','resident','ambient']`.
  The five new kinds are **appended**, so `entry(id)` without a kind still resolves an ambiguous id to
  the same kind it always did (`wood` is still block-then-crop). New export:
  `CONTENT_FAMILY_OF_KIND`.
- **`scripts/seal-content.mjs`** — `KINDS` gains `places`, `fixtures`, `activities`, `residents`,
  `ambient`; `FAMILY_OF_KIND`, `REFERENCE_FIELDS` and `TEXT_FIELDS` are the per-family checks.
  `node scripts/seal-content.mjs --check` went from
  `98 definitions (20 appearance, 9 block, 32 cosmetic, 6 crop, 31 furniture)` to
  `136 definitions (8 activity, 6 ambient, 20 appearance, 9 block, 32 cosmetic, 6 crop, 12 fixture, 31 furniture, 6 place, 6 resident)`.
- **No route or handler changed.** `server.js` derives its static table from `manifest().entries`, so
  every new definition file is served automatically and `GET /api/v1/content` returns the larger
  sealed manifest unchanged in shape. `tests/content-http.test.js` walks the whole client module graph
  from `/app.js` and passes, which is the proof.
- **No dependency was added.** `package.json` and the lockfile are untouched.
- `src/content-manifest.js` imports only `./footprints.js`. It is imported by the publication script
  and the tests; it is deliberately **not** in the browser module graph, so the client payload is
  unchanged apart from the 31 definition files the sealed bundle already had to include.

## 4. The manifest schema, and every refusal rule

A family manifest is `{ schema_version: 1, family, entries: [...] }` where each entry is the existing
content envelope (`schema_version`, `id`, `kind`, `label`, `since`, `order`, `license`, `appearance`,
`rules`, optional `notes`, optional `assets`) with `rules.family` naming the family and a per-family
`rules` group. The full per-kind tables are in `content/README.md` and `docs/CONTENT_MANIFEST.md`.

`validateContentManifest(manifest, options)` validates one family document.
`validateContentFamilies(bundle, options)` validates every authored family in a sealed bundle plus
the collisions *between* them, and requires a resolver — a bundle check without one would silently
skip every reference. Neither throws for content problems; they collect refusals, so a preview shows
every reason at once.

Every refusal is `{ code, rule, source, path, detail }`. The fourteen codes:

| code | refused when |
| --- | --- |
| `unknown-family` | the manifest claims a family outside the five |
| `schema-version` | the manifest or an entry declares a version the validator does not speak |
| `missing-field` | a field the family requires is absent or empty |
| `malformed-field` | wrong type, shape or range (`count-matches-tiles`, `sealed-furniture-geometry`) |
| `missing-license` | no usable licence record, an spdx outside the two evidenced identifiers, an unresolvable notice file, or a notice digest that disagrees with the seal |
| `missing-provenance` | no licence note, no source, a CC0 value with no pinned commit, project-authored work with a commit, or no `rules.provenance.derived_from` |
| `unresolved-reference` | a cross-family reference resolves to nothing, or to the wrong kind |
| `duplicate-id` | one kind and id appears twice in a manifest, a reference list, or an ambient layer |
| `id-collision` | an authored id already belongs to another kind, or a reference resolves to more than one kind |
| `footprint-collision` | footprint or scenery class disagrees with `src/footprints.js`; a tile is out of the site, doubles up, sits on the arrival, portal or public approach, or inside a country venue's walkable plaza band; a water tile is claimed by a ground mass or a mooring claims a non-water tile; a place's grid, arrival or portal disagrees with the live world; a tile is held by a saved plot or block column; a shared place claims to register land |
| `accessibility` | a declared value is below the bar this repository already enforces, a manifest relaxes a bar, or a route is unreachable |
| `nondeterminism` | a clock-reading key, a date, an epoch value, a generated id, a generator call, a slot list that does not increase, a cadence jitter with no authored source, a non-authored ordering, or a shared `order` |
| `independence-claim` | `fictional` is not true, `claims_endorsement`/`government_role`/`un_role` is not false, the disclaimer is absent or vacuous, or any visible label, note or remit asserts endorsement, representation or official status |

### The accessibility rules, and where each comes from

The validator *measures* rather than trusting the manifest: it computes the WCAG ratio from the
declared `#rrggbb` pair itself, and it refuses a manifest that declares a **target below** the bar,
not only one that fails it.

| rule | floor | source in this repository |
| --- | --- | --- |
| `hit-target` | 44 px | the control floor quoted and measured on every mobile control (`docs/MOBILE_ACCESSIBILITY.md`, `tests/mobile-styles.test.js`) |
| `layout-390` | 390 px | the phone width the atlas, globe and mobile layer must reflow to (`docs/COUNTRY_ATLAS.md`, `docs/COUNTRY_GLOBE.md`, `docs/MOBILE_ACCESSIBILITY.md`) |
| `contrast-text` | 4.5:1 | WCAG 2.1 AA 1.4.3, as measured in `tests/mobile-styles.test.js` |
| `contrast-nontext` | 3:1 | WCAG 2.1 AA 1.4.11, the bar the focus ring and key edge are held to |
| `reduced-motion` | a moving profile must state `equivalent-still`; a still one must state `not-needed` | animation is opt-in under `prefers-reduced-motion: no-preference` and every animated declaration has a suppression (`docs/MOBILE_ACCESSIBILITY.md`, `docs/CONTROLS.md`) |
| `walkable-route` | a country venue and a public venue plan return from their own arrival; a district returns from its south edge as `makeDistrict` roads it | `world.js` `countryApproach` / `countryScenery`, asserted by `tests/country-venues.test.js` |

### Non-determinism, name by name

`no-clock-field` (a `timestamp`/`created_at`/`now`/`date`/`seed`/`random`/`uuid` key inside `rules`),
`no-date-value` (an ISO-8601 string), `no-epoch-value` (a value in the millisecond-epoch range, as a
number or a 12–16-digit string), `no-generated-id` (a 32-hex or UUID literal), `no-generator-call`
(a string naming `Math.random`, `Date.now` or `randomUUID`), `ordered-slots` (a resident or activity
slot list that does not strictly increase, so the loop cannot depend on a map's iteration order),
`authored-jitter` (a cadence jitter above zero with no `jitter_source`), `authored-order`
(`ordering` other than `authored`) and `order-tiebreak`.

`order-tiebreak` is worth naming on its own because it is a real hazard in the shipped resolver:
`src/content.js` sorts by `order` and then by `String.prototype.localeCompare`, whose result depends
on the collation the runtime was built with. `tests/content-manifest.test.js` demonstrates the
divergence with `Intl.Collator('en')` vs `Intl.Collator('sv')` and *then* asserts the refusal.

## 5. How preview and publication differ

`scripts/content-publish.mjs`, reading a staging directory shaped like `content/`
(`content-incoming/` by default):

| mode | validates | seals a mirror | writes | leaves the tree |
| --- | --- | --- | --- | --- |
| `--preview` (default) | yes | yes | **nothing anywhere** | byte-identical |
| `--publish` | yes | yes | staged files, then the sealer | sealed and `--check`-verified |
| `--rollback` | — | — | restores the journal | exactly the pre-publication tree |

Preview is **not** a weaker check. Both modes run the same validator over the same proposed bundle and
both seal a *mirror* of `content/` with the staged files applied, using the real
`scripts/seal-content.mjs`, and read the three generated documents back. Publication additionally
compares the tree it produced against the previewed mirror, and rolls back and reports if they
disagree. The only difference is whether files are moved.

**Atomic and reversible, precisely.** Every destination path the run will touch, plus the three
generated documents, is recorded with its current bytes in `<staging>/.publish-journal.json` *before*
the first file is moved. Either every staged file lands and the seal verifies, or a failure —
including a verification mismatch — restores every touched path and reseals. It is **not** a single
filesystem rename, and the window between the first move and the verification is real; the journal is
what closes it. The journal is kept after a successful publication, so `--rollback` can undo the last
publication until the next one replaces it. A refused set exits non-zero, prints every refusal with
its rule, and never reaches the writing step: the generated documents are not even computed, and the
report says `not computed (the staged set was refused)`. `content/content-manifest.json`,
`content/notices.json` and `content/index.js` are therefore always produced by the sealer and never by
hand.

`--from DIR` names the staging directory, `--land FILE` supplies saved tiles a place or fixture may
not take, and `--json` appends a machine-readable report.

## 6. The operator walkthrough

Two publication runs were performed with the script. The transcript below is the **second, complete**
run: a one-file addition and a one-file replacement, 135 → 136 definitions. Its output is verbatim.
The first run published a complete six-file venue (`place` 5 → 6, `fixture` 10 → 12, `resident`
5 → 6, `activity` 6 → 7, `ambient` 5 → 6, total 129 → 135) and its output was lost when the second
run's transcript was written over it; the shipped tip contains both sets.

```
### 1. PREVIEW — validates and reports; writes nothing
Staged set: content-incoming
  files staged      2
  to add            1
  to replace        1
  already identical 0
  add       content/activities/pond-margin-walk.json
  replace   content/places/mosaic-field-venue.json  a8f6591229e8 -> da9c85ed67f5

Sealed definition count, before -> after
  activity       7 ->    8  (changed)
  ambient        6 ->    6
  appearance    20 ->   20
  block          9 ->    9
  cosmetic      32 ->   32
  crop           6 ->    6
  fixture       12 ->   12
  furniture     31 ->   31
  place          6 ->    6
  resident       6 ->    6
  total        135 ->  136

Generated documents
  content/content-manifest.json     would change  30d1e7a8fd86 -> b01ce2aaa4cb
  content/notices.json              unchanged
  content/index.js                  would change  3e1836fcb8dd -> 5f54ce5174ce

Live world shapes: checked against world.js for every place site
Validator: 38 authored entries over 5 families, 0 refusal(s)

Preview only: nothing was written (2 file(s) would change). Run with --publish to apply it.

### 2. PUBLISH — applies the staged set, reseals, verifies
Published 2 file(s); the sealer regenerated the manifest, notices and index and --check verifies.

### 3. ROLLBACK — undoes that publication from its journal
Restored 5 path(s) from content-incoming/.publish-journal.json; the seal verifies again.

### 4. PUBLISH AGAIN — the same staged set re-applied
Published 2 file(s); the sealer regenerated the manifest, notices and index and --check verifies.

### 5. A REFUSED SET — one bad place and one bad resident; nothing is written, nothing is sealed
Staged set: content-incoming-bad
  files staged      2
  to add            2
  to replace        0
  already identical 0
  add       content/places/bad-venue.json
  add       content/residents/bad-resident.json

Sealed definition count, before -> after
  activity       8 ->  n/a
  ...
  total        136 ->  n/a

Generated documents
  content/content-manifest.json     not computed (the staged set was refused)
  content/notices.json              not computed (the staged set was refused)
  content/index.js                  not computed (the staged set was refused)

Validator: 40 authored entries over 5 families, 10 refusal(s)
  REFUSED   accessibility [contrast-text] — places/bad-venue/rules.accessibility.contrast: the declared text target 3 is below the 4.5:1 this repository enforces; relaxing the bar is refused
  REFUSED   accessibility [hit-target] — places/bad-venue/rules.accessibility.hit_target_px: hit target 32 is below the 44 px floor
  REFUSED   accessibility [reduced-motion] — places/bad-venue/rules.reduced_motion: the profile moves ("drift"), so it must state "equivalent-still" or the motion has no suppression
  REFUSED   independence-claim [no-endorsement-claim] — places/bad-venue/rules.notes: "Endorsed by the ministry of Agriculture as an official representative." claims endorsement, representation or official status
  REFUSED   independence-claim — residents/bad-resident/rules.independence.claims_endorsement: claims_endorsement must be false: nothing in this content may assert endorsement
  REFUSED   independence-claim — residents/bad-resident/rules.independence.government_role: government_role must be false: a host is never a government or ministry role
  REFUSED   independence-claim [non-vacuous-disclaimer] — residents/bad-resident/rules.independence.statement: the disclaimer must actually negate an institution: it has to say that the space is not a government, ministry, embassy or United Nations office
  REFUSED   independence-claim — residents/bad-resident/rules.independence.un_role: un_role must be false: a host is never a United Nations role
  REFUSED   nondeterminism [order-tiebreak] — places/bad-venue/order: order 0 is also used by terrace-flight-venue; the resolver would break the tie with localeCompare, whose result depends on the runtime locale
  REFUSED   nondeterminism [order-tiebreak] — residents/bad-resident/order: order 0 is also used by venue-steward; the resolver would break the tie with localeCompare, whose result depends on the runtime locale
content-publish: 10 validation refusal(s); nothing was written
exit status: 1

### 6. The tree is untouched by the refused set
Verified: 136 definitions (8 activity, 6 ambient, 20 appearance, 9 block, 32 cosmetic, 6 crop, 12 fixture, 31 furniture, 6 place, 6 resident); 3 support files; 42 referenced notices and assets.
```

The staging directories were removed afterwards. `content-incoming/` is not committed; an operator
who wants one permanently should add it to `.gitignore`, which this slice deliberately did not edit.

## 7. What makes the country-venue and regional examples genuinely distinct

Each place **reuses existing venue machinery** and states which, in `rules.site.machinery`:

| place | site kind | machinery reused | structure kind |
| --- | --- | --- | --- |
| `terrace-flight-venue` | `country-variant` | `world.js` `makeCountry('NPL')` with `COUNTRY_VENUE_ASSIGNMENT.NPL === 'terraces'` | `terrace-flight` |
| `grove-ring-venue` | `country-variant` | `makeCountry('KEN')` with `'kaya'` | `grove-ring` |
| `channel-landing-venue` | `country-variant` | `makeCountry('MEX')` with `'chinampas'` | `channel-network` |
| `mosaic-field-venue` | `country-variant` | `makeCountry('JPN')` with `'satoyama'` | `field-mosaic` |
| `coast-landing-district` | `district` | `makeDistrict('district:coast')` over `src/civic.js` `REGIONS` | `road-and-plaza` |
| `amphitheatre-precinct` | `venue-plan` | `PUBLIC_VENUE_PLANS` / `makePublicVenue('venue:amphitheatre')`, 30 × 22 | `bowl-and-ring` |

They are not one template repeated. They differ in **site kind** (country venue, regional district,
commons venue plan), in **grid** (40 × 28, 48 × 36, 30 × 22), in **terrain vocabulary**
(meadow/path/farm/plaza; meadow/garden/path/plaza; meadow/farm/water/bridge/path/plaza;
meadow/water/path/plaza; meadow/garden/plaza/rug/path), in **structure kind** — all six different — in
**whether and how they declare water** (`channels` at x = 30–31 and y = 17 for the channel landing, a
`shore` strip below x = 5 for the coast district, none for the other four) and in the whole family set
they wire. `tests/content-manifest.test.js` asserts six pairwise-distinct signatures and six distinct
structure kinds, and asserts each place's declared grid, arrival and portal equal to the live world's.

One structural difference matters in practice: `band_rule` is `clear-of-mass` for a country venue
(whose `world.js` machinery paints its 16 × 16 plaza band last and keeps it free of solid scenery) and
`none` for a district (whose `makeDistrict` paints its plaza under its own lanterns). The validator
enforces the band rule for a **mass**, so the same `open-shelter` frame may stand in the band while a
bench may not.

**Independence.** Every place and resident carries `fictional: true`, `claims_endorsement: false`,
`government_role: false`, `un_role: false` and a **non-vacuous** disclaimer that names government,
ministry, embassy and the United Nations as things the space is *not*. The validator additionally
scans every visible label, note, remit, machinery string and reuse note for endorsement,
accreditation or official-status language and refuses it; the disclaimer is the one exempt field, and
only because it is required to negate an institution. **Nothing in this slice claims institutional
endorsement, real-world adoption or a finished launch.**

## 8. The determinism proof

`tests/content-determinism.test.js`, three tests. The first:

1. A fixture database saves four garden placements, two plantings, two shelf entries, a stewarded plot
   and two frontier block columns — through the product's own methods (`landAssign`, `frontierBuild`)
   and through inserts the storage triggers derived from the sealed content accept.
2. Every row of `worlds`, `world_objects`, `frontier_sectors`, `frontier_blocks`, `land_parcels`,
   `land_stewardships`, `land_events`, `plot_grants`, `journey_crops` and `journey_inventory` is
   digested, and the resolved kind, colour and builder of every stored id is recorded.
3. A **mirror** of `content/` gains two definitions (`furniture/orchard-lamp`, `blocks/mossstone`) and
   has the authored `order` of every furniture and block definition **reversed**; it is sealed by the
   real sealer and loaded back with the real resolver.
4. Asserted: the reorder really took effect (the presented furniture sequence changed); every saved
   row is **byte-identical**; every stored placement, block and crop id still resolves to the same
   kind, colour and builder; the list of resources a saved shelf can hold is unchanged; every
   generated world shape is identical; the content-derived SQL (`WORLD_OBJECT_GUARDS`,
   `FRONTIER_SCHEMA`, `JOURNEY_SCHEMA`, the four palettes) is identical; every untouched definition
   re-seals to a byte-identical digest; the reordered ones keep their licence, appearance and rules
   exactly; and the whole bundle still passes the family validator.

The second test draws the boundary: **removing** a definition a save references makes it stop
resolving (so the update must be additive), and a **cross-kind id collision** is refused by the
validator even though the bare resolver tolerates it and answers the ambiguous lookup in kind order
(`find('sundial')` returns `['furniture','resident']`). The third records a different class of change:
adding a definition **to a palette** rewrites the guard SQL a database was created with, which is a
schema-shaped change and is not shipped silently — which is the first known gap below.

The working tree is never touched by these tests; every mutation happens in a sealed mirror, so the
suite cannot leave the repository unsealed and cannot race the tests that shell out to the sealer.

## 9. Gate table (Node v24.15.0, actual results)

| Gate | Base (`27c0d72`) | Tip | Result |
| --- | --- | --- | --- |
| `npm run check` | 99 files, 0 failed | **101 files, 0 failed** | **pass** |
| `npm test` | 165 files, 1074 tests, 1074 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo (174.7 s) | **1094 tests, 1094 pass, 0 fail**, 0 cancelled, 0 skipped, 0 todo (650.7 s) | **pass** |
| `npm run e2e` | 20 steps passed, 0 failed | **20 steps passed, 0 failed** | **pass** |
| `node scripts/seal-content.mjs --check` | 98 definitions (20 appearance, 9 block, 32 cosmetic, 6 crop, 31 furniture); 3 support files; 42 referenced notices and assets | **136 definitions (8 activity, 6 ambient, 20 appearance, 9 block, 32 cosmetic, 6 crop, 12 fixture, 31 furniture, 6 place, 6 resident); 3 support files; 42 referenced notices and assets** | **pass** |
| `node --test tests/framework/known-gaps-content.mjs` | n/a | 2 tests, 0 pass, **2 fail (by design)** | **red on purpose** |
| `npm run browser` | not run | **not run** (deliberate — see §11) | **unrun** |

`npm test` gained **20 tests** (12 in `tests/content-manifest.test.js`, 5 in
`tests/content-publish.test.js`, 3 in `tests/content-determinism.test.js`) and no existing test was
deleted, skipped or weakened; the two edited tests assert a *larger* corpus than before. The tip's
wall-clock duration is 650.7 s against the base's 174.7 s, and that is **the machine, not the
change**: the box was at a load average of 76–85 throughout (other work is running on it), and the
same three new files take 36.5 s under that load and 8 s alone. No test is slower for a reason this
slice introduced; the only added work is fifteen sealer invocations and nine tree copies inside
temporary directories.

## 10. Findings, ranked

**Confirmed defect**

1. **A seventh crop definition forks the persisted schema silently.** `src/journey.js` derives
   `journey_crops.kind` as `CHECK(kind IN (…the sealed crop ids…))` at import time and the table is
   `CREATE TABLE IF NOT EXISTS`, so a fresh database gets the new kind and an existing one keeps the
   old clause — while both report `PRAGMA user_version` 25, which
   `RECOVERY_LIMITS.accepted_schema_versions` accepts and `validateDatabase()` cannot distinguish. A
   planting of the new kind then fails on the old database with a raw SQLite `CHECK constraint failed`
   rather than a refusal this project formats. Reproduced by
   `tests/framework/known-gaps-content.mjs` "KNOWN GAP 1". **Owner: persistence/schema owner.** The
   fix is a migration, which this slice is forbidden to write. A content-side workaround (stop
   deriving the CHECK) is also a schema change, so it was not attempted.

**Likely issue**

2. **The sealed furniture rules and the shared footprint table disagree for 18 of 31 furniture
   definitions.** `src/footprints.js` calls itself "One source of truth for what stands where", and it
   is what server movement, pathfinding, placement validation and the renderer all read; 18 sealed
   definitions declare `walkable: true` / `footprint: "open"` for types that table classes as a
   blocking `mass` — every seat, table, shelf, lamp, bed, boat and cactus among them, plus
   `civic-building`, `display`, `fruit`, `kitchen`, `mountain`, `palm` and `telescope`. Nothing
   compares the two: `src/content.js` validates the enum only, the sealer validates shape only, and
   `tests/footprints.test.js` never reads `content/`. Reproduced by "KNOWN GAP 2". **Owner:
   content/runtime owner.** Not fixed here because either repair changes behaviour beyond this slice —
   editing `src/footprints.js` changes where residents may walk, what pathfinding routes around and
   what the renderer blocks; editing 18 sealed definitions changes what the content layer publishes
   and invalidates their notice digests. The new validator deliberately does **not** flag it on a
   fixture, because a fixture's job is to agree with the enforced table, not to arbitrate a pre-existing
   dispute between two others.

**Design decision**

3. The five new kinds are **appended** to `CONTENT_KINDS` rather than interleaved, so `entry(id)`
   without a kind resolves exactly as before. The consequence is that a future consumer of
   `CONTENT_KINDS` sees the artwork kinds first and the authored families second.
4. The validator enforces `id` uniqueness across kinds for the **authored** families only, and
   tolerates the pre-existing shipped collision (`wood` is a block and a crop). Tightening it to the
   shipped kinds would require changing the shipped definitions.
5. `order` uniqueness is enforced per family. This is stricter than the shipped layer (which tolerates
   duplicates and falls back to `localeCompare`) because the fallback is locale-dependent; the shipped
   definitions have no duplicates today, so nothing had to change.
6. The reduced-motion rule is a biconditional: a still profile must state `not-needed`. A profile that
   claims an equivalent it does not have is refused, because that is a false claim about accessibility.
7. An activity records the schedule the living-world loop is *expected* to keep and says so in
   `rules.implements`; it is not yet read by `src/living-world.js`. This is declared, not implied.
8. `rules.site.band_rule` encodes a genuine difference between two machinery paths (country venue vs
   district) rather than one uniform rule.
9. The place records `site.machinery` as free text naming the code it reuses. The validator checks it
   is non-empty and `tests/content-manifest.test.js` asserts it names one of the known symbols, but
   prose cannot be fully checked.

**Untested / unverified**

10. `npm run browser` was **not run** — the integrator runs the Chrome suite serially and concurrent
    runs have produced false timing failures. Nothing in this slice renders anything new, so the
    expected risk is low, but no browser claim is made.
11. No visual or performance measurement of any place. The definitions draw nothing on their own; the
    venue shapes they bind are the pre-existing ones whose object counts are already bounded by
    `tests/country-venues.test.js`.
12. The client bundle payload grew by 31 definition files (`content/index.js` imports each one). The
    bytes were not measured.
13. `--land` (the saved-tile check) is exercised in `tests/content-manifest.test.js` with a synthetic
    occupied set; it was not run against a live land registry.
14. The publication script's rollback was verified by a full publish/publish-again cycle in
    `tests/content-publish.test.js` and in the walkthrough, not by killing the process mid-write.

## 11. What remains unimplemented, externally dependent, or unverified

- **No activity is executed.** The activities are schedules; wiring them into `src/living-world.js`
  is the next step and was out of scope.
- **No new scenery class, no new builder.** Every place reuses what `world.js` and
  `src/voxel-world.js` already draw. Adding a variant that needs new geometry would require
  `src/voxel-world.js`, which this slice may not edit.
- **The crop-family migration** in finding 1 is unowned.
- **The furniture/footprint drift** in finding 2 needs an owner decision on which surface is
  authoritative.
- **Palette widening is not shipped.** `tests/content-determinism.test.js` records that widening the
  garden palette rewrites the `world_objects` guard SQL a database was created with; that is the same
  class of problem as finding 1 and was deliberately left alone.
- **The staging directory is not ignored by git.** `content-incoming/` is removed from this worktree;
  an operator who wants one permanently should add it to `.gitignore`, which this slice did not edit
  to avoid colliding with the in-flight work on the CI and operations documents.
- **No production account, world or database was touched.** Every test uses a temporary database;
  the installed product and its data, backups, credentials and model weights were never read, written
  or run.

## 12. Migration and rollback

- **The database schema did not change** (still 25). No table, column, index, migration step, backup
  format or recovery check was touched.
- Rolling back the *code* is a source revert: the five definition directories, `src/content-manifest.js`
  and `scripts/content-publish.mjs` are new, and the four edited files have small diffs. Reverting them
  and running `node scripts/seal-content.mjs` restores the 98-definition manifest.
- Rolling back a *publication* is `node scripts/content-publish.mjs --rollback --from <staging>`, which
  restores every path the last publication touched from the journal and reseals.
