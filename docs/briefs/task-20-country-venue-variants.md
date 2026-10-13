# Task 20 design brief — eight country/area venue variants

**Status: design brief only. Nothing here is implemented.** No `.js` file, catalog, script,
`package.json`, world definition or content definition was changed by this task; this branch adds
Markdown only. No asset was downloaded, extracted or integrated and no message was sent to any
institution or person. The eight venues below are described, not built. The remaining 240 catalog
entries keep the **existing generic `makeCountry` shape** described in
[the Task 01 handoff](../handoff/task-01-country-ambassadors.md) until a variant receives separate
review.

- Branch: `task-20-venue-brief`
- Base commit: `4fbdff5` (`review/nemoworld-queue`, schema 18, 448/448 tests)
- Written: 2026-10-13
- Source checks: all pages below were opened on **2026-10-13** and only what the page actually stated
  is recorded. Where a page could not be read from this environment, that is stated as a gap rather
  than filled in.

## 1. What this brief is and is not

Task 20 asks for eight original country/area venue variants "using documented cultural/ecological
references with appropriate source and asset rights", integrated "through deterministic world
definitions and shared collision footprints", retaining "public arrival/exit access and each
ambassador's stand". This document is the **sanctioned design half** of that task.

It is **not**:

- a claim that any venue exists, renders, or has been seen in a browser;
- an asset licence, an asset download, or an integration decision;
- a research finding about any country's people, government or territory.

It **is**: a reviewable specification an implementer can follow, with the sources, the invariants,
the collision contract, the verification checks and the open questions written down.

## 2. The distinction to preserve (stated explicitly)

These are **fictional NemoWorld spaces inspired by documented references**. They are **not
representations of actual country territory, governments, institutions or peoples**.

- A venue is a generated 40 × 28 map of abstract cube geometry inside a shared virtual world. It
  claims no land, no boundary, no sovereignty and no affiliation. `catalog/countries.json` is an
  explicit statistical list of **countries and areas**, not 248 sovereign states, and a venue does
  not change that.
- The reference behind a variant is a **documented ecological or cultural practice** used as design
  inspiration for layout and palette. The venue does not depict, summarise or speak for that practice
  or the communities who hold it. The ambassador is a fictional NemoWorld research guide who answers
  from retained country context only, and nothing in a venue grants them authority they do not have.
- **Eight variants are not eight unique venues for 248 entries.** The first set assigns one reviewed
  variant to each of eight catalog entries; **240 entries keep the existing generic shape**. Even
  after further sets are reviewed, a variant is a **shared shape**: many entries use the same
  variant, and every venue within a variant differs only by its label, its ambassador and its
  landmark text. Reporting eight variants as "eight unique country venues" — or as country-specific
  architecture for a country that has none — would be false.

## 3. Shared venue contract (the invariants every variant must satisfy)

These are non-negotiable because shipped code and tests depend on them. A variant that breaks any of
them is not deliverable.

| Invariant | Why it is fixed | Where it is enforced today |
| --- | --- | --- |
| `kind: 'country'`, `columns: 40`, `rows: 28` | The `worlds` row is seeded 40 × 28 and recovery rejects any other size | `src/civic-engine.js:181` (seed), `src/recovery.js:118` (validate) |
| World id `country:<iso3>`, unchanged | Ambassadors are keyed `amb-<iso3>` in that world | `src/civic-engine.js` |
| Arrival (`start`) and every portal are **walkable and clear of solid scenery**, with a **route between them** | A resident must be able to enter and leave | `tests/footprints.test.js:95` |
| The **16 × 16 plaza band** `COUNTRY_VENUE_PLAZA` at `(12, 8)` is fully walkable, free of `mass` scenery, and its terrain is `plaza`/`garden` | Any of the 248 stand positions `(12 + i % 16, 8 + floor(i / 16))` can fall in it, and an ambassador must never be drawn inside an object | `world.js:312`, `tests/footprints.test.js:108` |
| Only **sealed terrain types** (`meadow, path, plaza, garden, water, bridge, tree, building, fountain, wall, floor, rug`) and **sealed scenery types** classified in `src/footprints.js` | An unrecognised scenery type fails closed as a `mass`; adding one needs a class, matching renderer geometry and the content seal | `src/footprints.js:35`, `tests/footprints.test.js:25` |
| No `frontier_sectors`, no `land_parcels`, no `frontier_blocks`, no `agents.z` registration, no `kind: 'country'` row in the bounded `GET /worlds` list | A venue is a generated shared space, never finite frontier land | `tests/ambassadors.test.js:45`, `src/spaces.js:98` |
| A **pure, deterministic** function of `iso3` | Server and renderer must agree, and two loads must be identical | new (see §5.1) |

A variant may choose its own `groundColor`, `ambiance`, `landmark` and object placement, keep the
approach roads and plaza band, and add scenery **outside** the plaza — exactly as `makeCountry`
already does.

## 4. The eight variants

Assignment (catalog position from `catalog/countries.json`, 248 entries; stand index
`i = catalog index`):

| # | Variant id | Country / area | ISO3 | Catalog idx | Stand | Dominant reference |
| --- | --- | --- | --- | ---: | --- | --- |
| A | `terraces` | Nepal | NPL | 153 | 21,17 | Community forest + mid-hill terraces |
| B | `satoyama` | Japan | JPN | 114 | 14,15 | Satoyama socio-ecological production landscape |
| C | `andenes` | Peru | PER | 171 | 23,18 | Andean terraces, `camellones`, `qochas` |
| D | `chinampas` | Mexico | MEX | 142 | 26,16 | Chinampa raised fields and channels |
| E | `argan` | Morocco | MAR | 148 | 16,17 | Argan agro-sylvo-pastoral system |
| F | `kaya` | Kenya | KEN | 118 | 18,15 | Community-governed coastal sacred forest |
| G | `fabod` | Sweden | SWE | 214 | 18,21 | Summer farming (`fäbod`) + right of public access |
| H | `reef` | Fiji | FJI | 77 | 25,12 | Locally managed marine area (`tabu`) |

All eight are **100% original NemoWorld art**: the world's renderer builds every tree, roof, bench,
pond, boat and rock from instanced flat-coloured 1 m cubes (`src/voxel-world.js`), and no variant
uses a third-party mesh, texture, audio file or traced design. See §6 for why no licensed pack is
integrated.

### A — `terraces` (Nepal)

- **Reference.** Nepal's community forestry — national forest formally handed to Community Forest
  User Groups (CFUGs) — combined with mid-hill terrace cultivation. Chosen because it is a
  documented, community-scale, non-martial practice of care for a shared resource, which is the
  register NemoWorld lives in.
- **Documented source.**
  - [FAO, *Community Forestry: Participatory Forest Management in Action* (Case Study 1)](https://www.fao.org/4/ad686e/ad686e06.htm)
    — states that CFUGs are "legally mandated in Nepal as state-sponsored community-based resource
    management organizations", that the programme lets rural communities manage forest "according to
    indigenous practices", and that CF is a prototypical group-oriented programme. Read 2026-10-13.
  - [FAO, *Targeting the poor: the Leasehold Forestry project* (Case Study 2)](https://www.fao.org/4/ad686e/ad686e07.htm)
    — states plainly that Nepal's CF policy "does not distinguish between users of unequal wealth or
    means; thus, it lacks an explicit focus on the poor", that benefits are often captured by local
    elites, and that "resource poor households and socially marginalized people … receive
    disproportionately smaller shares of benefits". Read 2026-10-13.
- **Uncertainty recorded (do not smooth over).** The community-forest reference is a real,
  well-documented institution **and** a contested one. The venue is therefore framed as a
  **maintained shared grove and watering point**, never as a completed or equitable programme. The
  landmark copy avoids any claim about who benefits.
- **Layout and landmark.** A stepped terrace on the north half of the map: three bands of `path`
  retaining edges with `farm` (`flat`) beds between them, so every level is walkable and connected.
  A managed grove of `tree` masses along the west edge, with a single `pond` as the village water
  tank and a `shelter` (`frame`) open rest pavilion carrying a `bench`. The landmark is
  **"The Shared Grove"**, standing on a grove-edge tile; the plaza band stays clear.
- **Navigability.** Terraces are `path`-stepped, so the north half is one connected piece reachable
  from the south approach road; the pond is `mass` and is routed around; arrival `(20, 25)` and the
  return portal `(20, 26)` sit on the south path.
- **Art.** Original cube geometry; reference informs only the stepped layout and a green-grey
  `groundColor`. No Nepali building, textile, motif or photograph is reproduced.

### B — `satoyama` (Japan)

- **Reference.** *Satoyama* — a managed mosaic of secondary woodland, paddy, irrigation pond,
  ditch and settlement, sustained by cyclic use of local resources.
- **Documented source.**
  [IPSI, *Satoyama Initiative* concept page](https://satoyamainitiative.org/concept/satoyama-initiative/)
  — states the Initiative was started jointly by the **Ministry of the Environment of Japan** and
  **UNU-IAS**; defines "socio-ecological production landscapes and seascapes" (SEPLS) as landscapes
  where "sustainable management at the landscape level can help to secure ecosystem services and
  conserve biodiversity"; lists the three-fold approach including **cyclic use of natural
  resources** and "evolving frameworks of 'commons' while respecting traditional communal land
  tenure"; and records its recognition at CBD COP 10 (Decision X/32). Read 2026-10-13.
- **Layout and landmark.** A working mosaic rather than a garden: a block of `farm` (`flat`) paddy
  beds separated by `path` bunds, a `pond` (`mass`) with a `path` walkable on two sides, and a
  woodland edge of `tree` masses across the west. A `shelter` (`frame`) marks the meeting place at
  the mosaic's centre, with `bench` and `lantern`. The landmark is **"The Mosaic Fields"**, placed on
  a bund tile so a resident stands beside the crop beds, not in them.
- **Navigability.** Every bund is `path`, so the mosaic is one connected walkable unit; the pond is
  routed around; arrival and portal stay on the south approach road; the plaza band is untouched.
- **Art.** Original cube geometry; the reference shapes the mosaic pattern and a soft green
  `groundColor` only. No Japanese architectural form, garden style, textile or artwork is copied.

### C — `andenes` (Peru)

- **Reference.** Andean agriculture: stone-faced terraces (*andenes*), raised ridge fields
  (*camellones*) and small rainfall reservoirs (*qochas*) across altitude bands.
- **Documented source.**
  [FAO GIAHS, *Andean Agriculture* (Peru)](https://www.fao.org/giahs/giahs-around-the-world/peru-andean-agriculture/en)
  — states the system is "one of the best examples of the adaptation and knowledge of farmers to
  their environment for more than 5000 years"; that indigenous knowledge includes "terraces, ridge
  fields, local irrigation systems"; that the GIAHS site has three altitude systems (maize
  2800–3300 m, potato 3300–3800 m, high-altitude crops/livestock 3800–4500 m); that *qochas* are
  "natural depressions … used as reservoir of rainfall water … linked together"; and that the system
  is adapted for soil and water sustainability. Read 2026-10-13.
- **Layout and landmark.** Two `path`-stepped terrace flights on the east and north, each with
  `farm` beds, rising to a `path` platform. A round `pond` (`mass`) sits in an open `path` ring as
  the *qocha*, so a resident walks the whole way around it. A `shelter` (`frame`) with a `bench` is
  the tool store and rest stop. The landmark is **"The Terrace Flight"** on the platform tile.
- **Navigability.** Both flights are `path`-connected to the approach road, the pond ring is a closed
  walkable loop with two connections to the road, and arrival/portal stay south.
- **Art.** Original cube geometry; only the terrace geometry (step, retaining edge, water ring) is
  borrowed in spirit. No Andean textile, ceramic or archaeological form is reproduced.

### D — `chinampas` (Mexico)

- **Reference.** Chinampa wetland raised-field agriculture: narrow farmed islands between channels,
  edged with trees, worked by canoe.
- **Documented source.**
  [FAO GIAHS, *Chinampa agricultural system of Mexico City*](https://www.fao.org/giahs/giahs-around-the-world/mexico-chinampas-agricultural-system/en)
  — states chinampas are "a kind of wetland raised-field agriculture composed by small islands in
  strips, built with the sediments from the lake bottom, branches and decaying vegetation, creating
  a web of channels"; that channels are "between 4 and 6 m average width", "used as means of
  transport navigated by canoes and *trajineras*", with "an average depth of 1.5 meters"; that
  cultivation uses "agroforestry and intercropped systems"; and that the managed vegetation
  comprises "51 domesticated species" plus 96 non-domesticated species. Read 2026-10-13.
- **Layout and landmark.** A `water` channel grid cut through the east half, with `farm` strip beds
  on the islands between channels and `tree` masses on the strip edges. Two `bridge` crossings keep
  every island reachable on foot, and a `boat` (`mass`) is moored at a `path` landing. The landmark
  is **"The Channel Landing"** on the boardwalk, not on a strip.
- **Navigability.** **This is the highest-risk variant for the arrival/exit invariant**: every
  `water` cell is `TERRAIN_BLOCKING`, so the plan must place the plaza band, the arrival, the portal
  and the landmark on land and cut at least two `bridge` crossings; a connected-component check (§7)
  is mandatory, not optional.
- **Art.** Original cube geometry; the reference gives the strip-and-channel rhythm and a watered
  `groundColor` only. No Mexican motif, mural, textile or archaeological artifact is reproduced.

### E — `argan` (Morocco)

- **Reference.** The argan-based agro-sylvo-pastoral system: drought-resistant trees combined with
  rainfed terrace crops, livestock, stone terraces and underground rain reservoirs, with water
  governed by a local committee.
- **Documented source.**
  [FAO feature story, *The Moroccan landscape, traditions and communities behind argan and its oil*](https://www.fao.org/newsroom/story/The-Moroccan-landscape-traditions-and-communities-behind-argan-and-its-oil/en)
  — states FAO designated Ait Souab-Ait Mansour a GIAHS in 2018; describes it as an "agro (farming)-
  sylvo (trees)- pastoral (goats) system"; records that "farmers have shaped flat, terraced areas on
  which to grow their food" and that "the stone terraces help the soils retain water and reduce
  erosion"; describes underground rain-water reservoirs called ***Matifiya***; and states water is
  managed through a local ***Jmaa***, "a 'committee of wise persons'", whose decisions "go
  undisputed". Read 2026-10-13.
- **Layout and landmark.** A dry, sparse map: `fruit`/`tree` masses in a wide grid (argan analogues),
  a `cactus` (`mass`) margin along the south edge, one `path`-stepped terrace with `farm` beds, and a
  `pond` (`mass`) as the cistern. The gathering place is a `shelter` (`frame`) with a `bench` and a
  `lantern`, and its landmark is **"The Assembly Shelter"** — a rest place, explicitly not a
  depiction of a *Jmaa* or of any named community.
- **Navigability.** The sparse tree grid leaves the approach roads and the plaza band open; the
  terrace flight is `path`-connected; arrival and portal stay south.
- **Art.** Original cube geometry; the reference sets the arid palette and the terrace/cistern
  elements. No Moroccan pattern, zellige, textile, building form or artisan object is reproduced.

### F — `kaya` (Kenya)

- **Reference.** The Sacred Mijikenda *Kaya* forests: residual coastal forest patches protected
  under customary law, gazetted as national monuments and governed by councils of elders with the
  National Museums of Kenya.
- **Documented source.**
  [National Museums of Kenya, *Kaya Kauma Project*](https://museums.or.ke/kaya-kauma-project/)
  — states the Sacred Mijikenda Kaya Forests are a UNESCO World Heritage site "comprised of 11
  separate sites"; that "56 Mijikenda sacred kayas" are "managed by traditional beliefs and
  practices", of which "39 are National Monuments, 4 forest reserves and 13 unprotected"; that they
  are "governed by councils of elders in collaboration with the National Museums of Kenya"; that
  they range from 902 acres to 3 acres; and that the Coastal Forest Conservation Unit was formed in
  1992 "with the task of caring for the Kayas in collaboration with local communities". Read
  2026-10-13.
- **Respect rule (hard).** This is a **living sacred forest**, not a scene. The venue therefore
  depicts **only**: a dense protected grove, a single cleared meeting area and a plain path. It
  **must not** depict or name any ritual, offering, shrine, ancestor practice, elder, *kaya* by
  name, or any of the 56 sites — and it must not be described as "the" Kaya forest. Its landmark is
  **"The Meeting Clearing"**. If reviewers judge even this too close to a sacred site, this variant
  should be replaced by an ecology-only Kenyan reference (see §8, Q5) rather than softened.
- **Layout and landmark.** A dense ring of `tree` masses enclosing a `garden`/`plaza` clearing,
  entered by one `path` corridor from the south, with a ring of `bench` outside the plaza band and a
  single `shelter` (`frame`) pavilion at the clearing's north edge.
- **Navigability.** The tree ring is `mass`, so the corridor is the one approach; the check that the
  clearing (which contains the plaza band) stays in the same connected component as the arrival is
  mandatory. The plaza band itself holds no `mass`.
- **Art.** Original cube geometry only, deliberately plain. No Kenyan object, textile, carving or
  photograph is reproduced.

### G — `fabod` (Sweden)

- **Reference.** Summer farming at a *fäbod* — livestock moved to outlying summer pasture with a
  dwelling, shed and dairy work, herding calls and storytelling — combined with the Swedish **right
  of public access** (*allemansrätten*), a legally protected shared right to cross and use land
  responsibly.
- **Documented sources.**
  - [UNESCO Intangible Cultural Heritage, *Summer farming at fäbod and seter* (no. 02109)](https://ich.unesco.org/en/RL/summer-farming-at-fabod-and-seter-knowledge-traditions-and-practices-related-to-the-grazing-of-outlying-lands-and-artisan-food-production-02109)
    — inscribed **2024** on the Representative List (Sweden and Norway); states summer farming
    "refers to the practice of moving livestock to outlying lands in late spring" and entails "animal
    husbandry and herding, dairy production, land management and handicrafts" as well as "herding
    calls, songs, storytelling and rituals"; that summer farms "may be private or collectively run";
    and that the practice "contributes to the well-being of people and animals, the production of
    quality food products, and biodiversity". Read 2026-10-13.
  - [Naturvårdsverket (Swedish Environmental Protection Agency), *The right of public access*](https://www.naturvardsverket.se/en/topics/the-right-of-public-access/)
    — states the right of public access "is built on shared responsibility, requiring everyone to
    respect wildlife, nature, landowners, and fellow outdoor enthusiasts", and that while it applies
    in most places "there are some exceptions". Read 2026-10-13.
- **Layout and landmark.** An open pasture of `meadow` and `farm` (`flat`) with a wide `path`
  **through-route** running the full north–south length of the venue and staying unobstructed — the
  design figure for allemansrätten, the shared right to pass. A `shelter` (`frame`) summer hut with a
  `bench`, a `pond` (`mass`) watering point, `flowers` and a `trellis` along the pasture edge. The
  landmark is **"The Summer Pasture"** on a pasture tile beside the through-route.
- **Navigability.** The through-route guarantees the venue is crossable end to end without leaving
  walkable ground; arrival and portal sit on it; the plaza band is clear.
- **Art.** Original cube geometry; the reference gives the open pasture register, the hut concept and
  a pale green `groundColor`. No Swedish building, painting, craft object or emblem is reproduced.
  **Note:** *allemansrätten* is a legal principle, not a place; the venue borrows the idea of a
  maintained shared route and claims nothing about Swedish law or land.

### H — `reef` (Fiji)

- **Reference.** Fijian locally managed marine areas (LMMAs) with a periodically harvested no-take
  closure (***tabu***), sited within a customary fisheries tenure area (*qoliqoli*) with the Fiji
  LMMA network (FLMMA).
- **Documented source.**
  [Weeks & Jupiter, *Adaptive Comanagement of a Marine Protected Area Network in Fiji* (peer-reviewed, PMC4232917)](https://pmc.ncbi.nlm.nih.gov/articles/PMC4232917/)
  — states "approximately 400 villages have established LMMAs with support from the Fiji Locally
  Managed Marine Areas network (FLMMA)"; describes the Kubulau District network of "3 district
  no-take areas and 21 village-managed *tabu* areas" covering 120 km²; notes that traditional
  fishing rights "are recognized under the Fiji Fisheries Act"; defines a *tabu* area as "a locally
  managed fisheries closure" that may be periodically opened; and records "boundary markers" as a
  compliance feature. Read 2026-10-13.
- **Layout and landmark.** A lagoon: `water` cells across the east third with a `path` boardwalk and
  a `bridge` landing over the waterline, two `boat` (`mass`) hulls moored at the boardwalk, a `pond`
  (`mass`) and `palm`-style `tree` masses along the shore, and a plain original **marker post**
  (`sculpture`, `mass`) standing on land as a boundary-marker analogue. The landmark is **"The
  Landing"**, on the boardwalk.
- **Navigability.** The boardwalk and bridge keep the shore, landing and plaza band in one connected
  walkable piece; water is routed around; the marker post is deliberately on land, not on the plaza
  band. Connectivity check mandatory (water-heavy).
- **Art.** Original cube geometry; the reference gives the shore, landing and moored-boat elements
  and a blue-green `groundColor`. No Fijian carving, *masi* pattern, canoe design or photograph is
  reproduced, and the venue makes no claim about any *qoliqoli*, village or chief.

## 5. Integration design

### 5.1 Deterministic selection

Add two frozen tables to `world.js` (implementation task; described here, not written):

```js
export const COUNTRY_VENUE_VARIANTS = Object.freeze(['generic', 'terraces', 'satoyama', 'andenes',
  'chinampas', 'argan', 'kaya', 'fabod', 'reef']);
export const COUNTRY_VENUE_ASSIGNMENT = Object.freeze({ NPL: 'terraces', JPN: 'satoyama',
  PER: 'andenes', MEX: 'chinampas', MAR: 'argan', KEN: 'kaya', SWE: 'fabod', FJI: 'reef' });
export function countryVenueVariant(iso3) { return COUNTRY_VENUE_ASSIGNMENT[iso3] ?? 'generic'; }
```

- **Selection is a pure lookup of `iso3`**, so it is deterministic by construction: same `iso3` → same
  variant, on every boot, in every process, with no randomness, no clock and no database read. The
  server and the browser both import `world.js`, so they cannot disagree.
- **A hash-based default is explicitly rejected.** `seed % 8` (or an `iso3` hash) would silently
  re-shape all 248 venues at once, which contradicts the requirement that unassigned entries keep the
  existing generic shape until they are reviewed. Only an **authored, reviewed assignment** may give
  an entry a variant.
- `makeCountry(id, label)` keeps its signature and its returned shape. It resolves
  `variant = countryVenueVariant(iso3)` and delegates object/terrain construction to a per-variant
  builder. The definition may additionally expose a plain `variant` string for tests and diagnostics
  (adding a field is safe: `getWorldDefinition` merges descriptors).
- The `worlds` row is **not** changed: `src/civic-engine.js` continues to seed
  `country:<iso3>` / `"<Country> research venue"` / `kind 'country'` / 40 × 28, and
  `src/recovery.js` continues to validate exactly that.

### 5.2 Shared collision and footprint model

- Terrain is authored as a grid of **sealed terrain types** only. Scenery is authored as objects
  whose `type` is one of the sealed `SCENERY_CLASSES` keys, so `walkable()`, `canStep`, `planWalk`,
  `escapeColumns`, placement validation and the renderer all resolve through the one table with no
  new code path.
- **The first eight variants need no new scenery type.** Each is expressible with existing `mass`
  (`tree, palm, cactus, fruit, pond, bench, lantern, table, boat, sculpture`), `flat`
  (`farm, flowers`) and `frame` (`shelter, gateway`) types plus `path`/`plaza`/`garden`/`water`/
  `bridge` terrain. If implementation finds a variant needs a genuinely new type — a terrace step, a
  marker cairn, a channel edge — that type **must** (a) be added to `SCENERY_CLASSES` with an explicit
  class, (b) get matching renderer geometry in `src/voxel-world.js`, (c) be added to the sealed
  content definitions and the content seal, and (d) keep `BLOCKING_SCENERY ∪ DECORATIVE_SCENERY`
  equal to the table's keys. Without all four, the type fails closed as a `mass` and the variant is
  wrong.
- **Plaza clearance is the load-bearing collision rule.** No `mass` object and no blocking terrain
  may fall inside `(12, 8, 16, 16)`, because any of the 248 stand positions can land there.
- Water-heavy variants (D `chinampas`, H `reef`) are the ones that can break connectivity: every
  variant's arrival, portal, landmark and plaza band must be in **one connected walkable component**.

### 5.3 Public arrival/exit and the ambassador's stand

- **Arrival and exit are retained in every variant**: `start = { x: 20, y: 25 }` and
  `portals = [portal(20, 26, 'Return to the Commons', 'commons')]`, exactly as the shipped generic
  venue. A variant may relocate them only if the relocated pair passes the same walkable/clear/route
  check; the safest first cut keeps them where they are and designs the variant **around** the south
  approach.
- **The ambassador's stand is retained**: the 16 × 16 plaza band stays walkable and clear, so the
  fixed stand `(12 + i % 16, 8 + floor(i / 16))` for each assigned entry is valid, and the ambassador
  continues to hold it (no patrol, no per-tick writes — unchanged).
- **Entry stays the existing directory rule**: a resident in the Commons may `travel` into any
  `country:<iso3>` venue (`src/spaces.js:205`), and the venue's own portal returns it to the Commons.
  No new gateway, corridor, frontier sector or land parcel is introduced.
- **Copy rule.** The venue `description` keeps the sentence "a NemoWorld research venue for one
  country or area", and no venue text claims to represent a country, people or institution. The
  provenance (reference name, source URL, check date) lives in **this brief and the handoff**, not in
  player-facing copy, so the world never ships an implied endorsement.

## 6. Constraints (all mandatory)

1. **No new sale inventory.** No plot, parcel, deed, price, payment, coin, resale or transfer is
   introduced. Venues are generated shared spaces; nothing in them is purchasable.
2. **No new frontier areas or land parcels.** No `frontier_sectors`, `land_parcels`,
   `frontier_blocks` or `agents.z` registration; the 16 × 16 perimeter, the 16,384 gross slots and
   the 8,192/8,192 reserved split are untouched; `kind: 'country'` venues stay excluded from the
   bounded `GET /worlds` list.
3. **One-original-or-verified-licensed art.** Every variant is **original NemoWorld geometry**.
   No third-party asset is integrated. The reason is concrete, not cautious: the pinned renderer
   bundle (`assets/vendor/three-voxel.js`, 551,333 bytes, hash-checked by tests) exports no model or
   texture loader, so no mesh pack is a drop-in, and
   [the asset shortlist](../research/ASSET_SHORTLIST.md) records that adopting one means
   re-bundling and re-hashing the renderer — an engine decision that has not been taken. The
   shortlist's usable CC0 packs (Kenney, KayKit) therefore remain **visual references**, and its
   unresolved register (Quaternius QAL v1.0, Terasology PlantPack, the missing root `LICENSE`) is
   **not** cleared by anything here.
4. **Navigable in orbit, first-person and text mode.** Orbit needs a map at least as large as the
   camera window (40 × 28 ≥ 20 × 14, satisfied) and open ground near the arrival; first-person needs
   walkable arrival, route and landmark approaches; text mode needs named landmarks, portals and an
   object list, and the aim line must name the new landmark. §7 gives the verification.
5. **No behaviour change outside country venues.** Ambassadors, conversations, frontier, land,
   economy, quests and guilds are untouched; the 240 unassigned entries render the current generic
   shape byte-for-byte.

## 7. How navigability and correctness would be verified (checks an implementer can run)

Nothing below has been run — the variants do not exist. These are the checks to add with the code.

```sh
cd work/t20
export PATH="$PWD/../node-bin:$PATH"
npm run check                 # syntax gate, must stay green
npm test                      # full suite; the new test file is included
```

1. **Determinism (run twice, compare).** A pure lookup must produce identical output across processes:

   ```sh
   for i in 1 2; do node --input-type=module -e "
     import('./world.js').then(m => { for (const id of ['country:NPL','country:JPN','country:PER',
       'country:MEX','country:MAR','country:KEN','country:SWE','country:FJI'])
       console.log(id, m.getWorldDefinition(id).variant, JSON.stringify(m.getWorldDefinition(id).objects)); });"; done | diff - -
   ```

   Two identical runs and a non-empty `variant` field prove the selector is deterministic and that
   the eight ids resolve to their assigned variants.

2. **New `tests/country-venues.test.js`** (mirroring existing suites, no new dependency):
   - **Registry integrity:** the eight assignments exist; every assigned `iso3` is in
     `catalog/countries.json`; every variant id is in `COUNTRY_VENUE_VARIANTS`; an unassigned `iso3`
     returns `'generic'`; both tables are frozen.
   - **Invariant per variant, all eight ids:** `columns === 40 && rows === 28`; `kind === 'country'`;
     `walkable(start)` and `solidSceneryAt(start, objects) === false`; for every portal, walkable,
     clear, and `planWalk(definition, start, portal)` is non-null (reusing
     `tests/footprints.test.js:95`'s pattern); **every one of the 256 plaza-band tiles** is walkable,
     free of `mass` scenery, and `terrainAt` ∈ `{plaza, garden}`; the assigned stand for that `iso3`
     is walkable and clear (reusing `tests/footprints.test.js:108`'s pattern but for the eight
     assigned entries, not the current 40-entry sample); every authored `type` is in
     `SCENERY_CLASSES`.
   - **Connectivity:** a cardinal BFS from `start` over `walkable` reaches the plaza band, the
     landmark tile, every portal, and every non-solid scenery neighbour — this is the test that
     catches water-heavy variants.
   - **Frontier invariance:** capture `worlds kind='frontier'`, `land_parcels`, `frontier_sectors`
     and `land_parcels WHERE world_id LIKE 'country:%'`, resolve all eight venues, assert unchanged
     (reusing `tests/ambassadors.test.js:45`'s pattern).
   - **Renderer agreement:** add the eight `country:<iso3>` ids to `worldIds` in
     `tests/footprints.test.js:17` so the existing "every scenery type is classified" and "renderer
     draws each class as declared" tests cover the new geometry, and render each variant twice
     through `createVoxelScene().update(...)` asserting identical instance counts (deterministic
     geometry) and no throw.
   - **Text mode:** assert each variant's `landmarks` and `portals` are non-empty and named, and that
     the map fallback can enumerate them (the same data the text view lists).
3. **Orbit / first-person / text walkthrough (manual, disposable database, no browser automation in
   this repo).** The exact steps for the later reviewer: start a local server on a temporary
   database, enter each venue from the Commons, orbit the camera around the arrival, switch to first
   person and walk arrival → portal and arrival → landmark using the on-screen keys, confirm the aim
   line names the new landmark and reports walkable/solid correctly, then confirm the text map lists
   the landmark and the return portal. **Task 15 is the task that replaces this manual step with an
   executable browser suite**; until then no browser coverage is claimed.
4. If (and only if) a new scenery type is introduced, `node scripts/seal-content.mjs --check` must
   still verify, with the recounted definitions documented.

## 8. Unresolved questions and rights/source gaps (must be closed before implementation)

**Rights and assets**

1. **No licence may be inherited.** There is no root `LICENSE` and `package.json` is `private` with
   no licence field (recorded in
   [the asset shortlist](../research/ASSET_SHORTLIST.md) and `docs/CONTENT_DEFINITIONS.md`). Until
   the owner decides, all eight variants must stay original geometry. **Open.**
2. **The renderer cannot load a mesh pack.** The pinned bundle has no loader and is hash-checked.
   Adopting any shortlisted CC0 pack (Kenney/KayKit) requires an explicit re-bundle/re-hash decision.
   **Open — blocks any licensed art.** No pack was downloaded or inspected.
3. **Unverified candidates stay unusable.** Terasology PlantPack has no asset licence; Quaternius is
   QAL v1.0 with a redistribution question; KayKit in-archive licence files were never inspected.
   None of these may be used by a variant. **Open.**

**Sources**

4. **UNESCO World Heritage page for the Kaya forests was not read.** `whc.unesco.org` returned
   **HTTP 403** from this environment, so the Kenya variant cites the National Museums of Kenya (the
   Kenyan focal point). Before implementation, read the WHS listing through an allowed route to
   confirm the "11 sites / 39 monuments" figures against UNESCO's own text. **Open.**
5. **The OECD Fiji governance report also returned HTTP 403**, so Fiji is cited to the peer-reviewed
   article. An official Fijian government source (e.g. the Ministry of Fisheries) should be read
   before implementation. **Open.**
6. **Nepal is cited to FAO**, not to a Nepali government source. If an in-country citation is
   required, read the Department of Forests and Soil Conservation / Ministry of Forests and
   Environment. **Open.**
7. **No source was checked against a rights holder's own licence text for any venue art**, because no
   art is being taken. **Open by construction.**

**Design and policy**

8. **Who approves the assignment?** Which eight entries get a variant, and who signs off the
   mapping. The proposal uses one entry per variant, chosen for regional and ecological diversity,
   but the choice is editorial. **Open.**
9. **Cultural review of living practices.** The Kenya (sacred forest), Fiji (customary tenure),
   Sweden (living *fäbod* practice, with Norway named in the same ICH inscription), Mexico and Peru
   (Indigenous agricultural systems) references involve living communities and their heritage. Who
   reviews the respectful framing — and should the Sweden variant avoid pairing the living practice
   with the legal access principle? **Open.**
10. **May venue copy name a reference at all?** One option is to name only the element ("terrace
    garden", "channel landing") and never the country's practice, which is safer but less
    informative. **Open — needs a product decision.**
11. **Does the Kenya variant belong in the first eight?** The respect rule in §4-F is deliberately
    restrictive. If reviewers judge any depiction of a sacred forest too close to the real sites, the
    honest alternative is an ecology-only Kenyan reference, not a looser depiction. **Open.**
12. **New scenery types?** If any variant needs a terrace step, cairn or channel edge, that triggers
    footprint-class, renderer-geometry, content-seal and documentation work. **Open — prefer none.**
13. **Stand-test sample width.** `tests/footprints.test.js:108` currently checks only the first 40
    catalog entries' stands. The new test should cover the eight assigned stands; widening the
    shipped sample is a coverage change that must be reviewed, not slipped in.
14. **Orbit semantics.** "Navigable in orbit" is a camera view, not a walk; the check is that the
    venue is large enough and open enough near the arrival for the orbit camera's clamp to show it.
    Confirm the intended acceptance wording with the task owner.
15. **Object counts and the renderer cap.** `docs/VOXEL_WORLD.md` bounds a view to 260 scenery
    objects and 37 × 37 cells. Each variant should stay well inside that; measure per variant before
    delivery.

## 9. Verified versus proposed

| Item | Status |
| --- | --- |
| Eight catalog entries and their exact stand tiles | **Verified** from `catalog/countries.json` (248 entries) |
| The generic `makeCountry` invariants (40 × 28, plaza band, arrival/portal, `kind: 'country'`) | **Verified** in `world.js`, `src/civic-engine.js`, `src/recovery.js`, `tests/footprints.test.js`, `tests/ambassadors.test.js` |
| `src/footprints.js` as the single occupancy table and its three classes | **Verified** in `src/footprints.js` and `docs/VOXEL_WORLD.md` |
| That no licensed pack is a drop-in (no loader, hash-pinned bundle) | **Verified** in `docs/VOXEL_WORLD.md` and `docs/research/ASSET_SHORTLIST.md` |
| The eight reference sources and what they state | **Verified** by reading the pages listed (checked 2026-10-13); UNESCO WHS and OECD pages not readable (403), recorded as gaps |
| The eight venue layouts, landmarks, palettes and object vocabularies | **Proposed** — design only, nothing built or rendered |
| The deterministic selector tables and the `variant` field | **Proposed** — implementation task |
| Navigator checks, the new test file, the orbit/first-person/text walkthrough | **Proposed** — none run; no browser check performed |

## 10. Source register (all checked 2026-10-13)

| Variant | Source (URL) | What the page states (as read) |
| --- | --- | --- |
| A Nepal | https://www.fao.org/4/ad686e/ad686e06.htm | CFUGs legally mandated, state-sponsored community-based resource management organizations; communities manage forest per indigenous practices |
| A Nepal | https://www.fao.org/4/ad686e/ad686e07.htm | Nepal CF "lacks an explicit focus on the poor"; benefits often captured by elites; marginalised groups receive smaller shares |
| B Japan | https://satoyamainitiative.org/concept/satoyama-initiative/ | Started by Japan's MOE and UNU-IAS; SEPLS definition; three-fold approach incl. cyclic resource use and communal tenure; CBD COP 10 recognition |
| C Peru | https://www.fao.org/giahs/giahs-around-the-world/peru-andean-agriculture/en | 5000+ years; terraces, ridge fields, local irrigation; three altitude systems; *camellones* and *qochas* described |
| D Mexico | https://www.fao.org/giahs/giahs-around-the-world/mexico-chinampas-agricultural-system/en | Raised-field islands in strips; web of channels 4–6 m wide, 1.5 m deep, canoes/trajineras; agroforestry; 51 domesticated + 96 non-domesticated species |
| E Morocco | https://www.fao.org/newsroom/story/The-Moroccan-landscape-traditions-and-communities-behind-argan-and-its-oil/en | GIAHS 2018; agro-sylvo-pastoral system; stone terraces; underground *Matifiya* reservoirs; water managed by a *Jmaa* committee of wise persons |
| F Kenya | https://museums.or.ke/kaya-kauma-project/ | 11 WHS sites; 56 sacred kayas (39 monuments, 4 reserves, 13 unprotected); governed by councils of elders with NMK; CFCU formed 1992 |
| G Sweden | https://ich.unesco.org/en/RL/summer-farming-at-fabod-and-seter-knowledge-traditions-and-practices-related-to-the-grazing-of-outlying-lands-and-artisan-food-production-02109 | Inscribed 2024; livestock to outlying lands in late spring; husbandry, dairy, land management, handicrafts, herding calls/songs/storytelling; biodiversity and well-being |
| G Sweden | https://www.naturvardsverket.se/en/topics/the-right-of-public-access/ | Right of public access built on shared responsibility; respect wildlife, nature, landowners, others; exceptions apply |
| H Fiji | https://pmc.ncbi.nlm.nih.gov/articles/PMC4232917/ | ~400 villages have LMMAs with FLMMA; Kubulau network 3 no-take areas + 21 village *tabu* areas (120 km²); *tabu* = locally managed fisheries closure; rights recognized under the Fisheries Act; boundary markers |

## 11. Honest limitations

- **Nothing is implemented.** No `.js`, `catalog/`, `scripts/`, `package.json` or content file was
  changed; no asset was downloaded, extracted, converted or integrated; no message was sent to any
  institution or person.
- **No browser check was performed**, and none is claimed. The orbit/first-person/text verification
  is a plan; the executable browser suite is Task 15.
- **The eight variants are design proposals.** Their layouts, landmarks and palettes have not been
  rendered, walked or measured, and their object counts against the 260-object renderer bound have
  not been counted.
- **References are inspiration, not representation.** Every source above documents a real practice;
  none of it authorises depicting a country, people, government or institution, and no venue does.
- **Two source gaps remain open** (UNESCO WHS for Kenya, OECD for Fiji) and are listed for closure
  before implementation rather than being papered over.
