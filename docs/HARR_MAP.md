# Harr's map: roads, districts, gateways and lawns

Harr's 36 public works were scattered over the hamlet with nothing between them. The map stream adds the missing
infrastructure: a paved, lit road network that reaches every work site, colour-coded quarters with stone gateways,
junction plazas with signposts, and soft landscaping. Everything is ordinary manifest groups (Rock/Earth/Grass blocks and
allowed sprites), generated and checked by code. Nothing in it fights, hunts, hoards or endangers anyone.

Previews: `evidence/map/map.png` (whole village), `evidence/map/map.txt` (ASCII), `evidence/map/map-t015|045|090|180|360.png`
(the same map at five minutes of the open-world clock) and `evidence/map/check.txt` (the overlap / limits report).

## District legend

Paving is Rock laid flush with the ground. Each quarter has its own pale tint; the kerb is teal everywhere.

| Quarter | Paving colour (rgb) | ASCII | What belongs to it |
|---|---|---|---|
| Learning | periwinkle `150,182,240` | `L` | schoolhouse, seminar pavilion, open archive, library annex, research tower, star observatory |
| Making | amber `244,184,110` | `M` | makers workshop hall, recycling garden |
| Living | soft green `150,212,150` | `V` | cottages 1 to 9, guesthouse, vertical farm |
| Gathering | lilac `200,158,230` | `G` | market hall, plaza well, light fountain, amphitheatre, festival lawn, glass garden, field pavilion, field hut |
| Water and energy | yellow `246,228,110` | `E` | two solar fields, wind array, water tower |
| Transport | slate `120,134,158` | `T` | sky transit hub, tram halt, canal bridge, sky walk |
| Civic roads and plaza | pale `205,220,236` | `c` | the square and the roads close to it |
| Kerb / crossing | teal `40,200,190` / white `246,248,250` | `-` | edges of every road; crossing bars on the paths |

A road cell takes the colour of the quarter of the nearest work site (within 6 blocks of a site always, otherwise the civic
colour inside 15 blocks of the plaza, otherwise the nearest quarter within 28 blocks). Walking out of the plaza you therefore
see the pale square turn periwinkle toward the library, amber toward the workshop and green toward the cottages. Names cannot
be written in blocks, so colour is the wayfinding: arch, junction inlay and paving of one quarter share one colour.

## Layout

Coordinates below are plaza-relative blocks (x east, y north, Plaza centre 0,0). World position = Plaza (15213, 15977) plus
that offset; the site origin (15216, 16016) is (3, 39).

* **The plaza** (`map-plaza`, 6 stages): a 25 x 11 paved square, x -11..13, y -1..9, with a lilac ring and cross inlay, a
  fountain basin at (-4, 4) (7 x 7 stone rim with four step gaps, sky-blue floor, a tall street lamp on a plinth, two
  benches), and stone planters at the corners. Existing props (meeting-corner benches, market crates) are left standing on
  the paving.
* **Seven trunk roads** (`map-road-*`, 3 blocks of paving plus teal kerb each side): east (along the old lantern path),
  north, south, west, north-west, south-west and an east spine. They are routed between hand-picked waypoints and bend
  around every existing wall, floor, pillar and sprite.
* **35 site paths** (`map-path-<site>`): one spur from every work site (the 36 works except the lantern path and the orchard gate, which the east trunk already passes, plus the field hut) to the nearest road,
  found by a turn-penalised shortest-path search over a 3-wide corridor, so paving never touches a building. Nearest sites
  connect first and later ones branch from the earlier paths, which gives a tree rather than a star.
* **Junction plazas**: a 5 x 5 pad (pale ring, district-coloured inlay, teal heart) where a long path leaves its road and in
  front of every site; 38 pads. A Sign sprite stands on the corner that faces the branch and stone planters on the other free
  corners (22 signs, 18 planters). Two white crossing bars mark each long path three cells from its junction.
* **Lighting**: a StreetLamp on the kerb about every 8 blocks (alternating sides), then any stretch still more than 9 blocks
  from a street lamp gets one: 42 new lamps (plus the 12 street lamps the works already had at ground level). The check requires every paved
  cell to be within 12 blocks of a street lamp; the worst gap is about 8 blocks.
* **Gateways** (`map-gate-<quarter>`, 2 stages: pillars, then lintel): a Rock arch 7 blocks wide (pillars 1 x 1 x 4 in the
  quarter's accent colour, a lintel at height 5 in its paving colour with a teal keystone, a Sign on each side) where each
  quarter's road begins.

| Gateway | Plaza-relative | World x, y |
|---|---|---|
| Learning | (-30, 29) | 15183, 16006 |
| Making | (2, 20) | 15215, 15997 |
| Living | (-29, -17) | 15184, 15960 |
| Gathering | (7, -6) | 15220, 15971 |
| Water and energy | (11, -33) | 15224, 15944 |
| Transport | (-45, 7) | 15168, 15984 |

* **Landscaping** (`map-land-<quarter>`, 2 to 3 stages each): domed Grass mounds (Grass blocks, three layers, radius 3 or 2)
  set 5 to 12 blocks off the roads on open ground, and a stone planter beside the first mound of each quarter. Around the plaza:
  the basin rim and planters described above. Fills are Grass and stone; no plants are placed (players could pick them).

## Staging: the roads appear progressively

Every map project is a staged project on the open-world clock (`release_after_minutes`), never needs a crew, and is listed
on the works board (`content/veloren-projects.json`, ids starting `map-`). A stage is at most 12 road cells long and is its own
group, so each stage measures the ground at its own anchor (see Risks).

| Minutes | What appears |
|---|---|
| 2 to 17 | the plaza paving, then its basin and planters |
| 6 to 38 | the seven trunk roads, a few cells per stage |
| 13 to 173 | each site path, released shortly before its site's own works begin and never before the road it joins |
| 25 to 66 | gateways (about 20 minutes after the first path of the quarter) and lawns |

By minute 45 about half of the map stages stand, by minute 180 all 135 do (see `evidence/map/timeline.txt`).

## How it is generated

* `tools/gen-harr-works.py` writes the works, then calls the hook `append_network()` in `tools/gen-harr-network.py` (it is
  also runnable on its own). The network generator removes every group whose project starts with `map-`, rebuilds them
  deterministically (no randomness) and writes the manifest and the works catalogue. It refuses to write if the check below
  fails.
* Plan: read the footprints of every existing work (`tools/harr_layout.py`), route, pave, kerb, light, add pads, gates and
  lawns, cut into stages, emit ops. Paving per cell: `foundation` depth 2 (Earth) under it, `clear` z 1..2 above it (not where an
  existing sprite stands), `fill` Rock at z 0 in the quarter's colour, teal Rock kerb at z 0, lamps as sprites at z 1 on the
  kerb. Ground height is measured per group at its own anchor, which is a paved cell.
* Anchors: every group is anchored on the nearest of the five plots with |dx|, |dy| at most 48 (the JavaScript validator's
  limit), `ground_at` is the anchor itself.
* One existing fix: the glass garden's clearing used to cut down the last two lamps of the lantern path, so the lantern path
  now stops at x 31 (`tools/gen-harr-works.py`).

## Automated checks (all groups, works and map)

* `python3 tools/check-harr-map.py` (shared code in `tools/harr_layout.py`): every Rust and NemoWorld limit on every group
  (600 ops, +-48 extent, heights -12..24, fills 4096, 6000 blocks per group, 60000 in total, foundation depth and columns, kinds,
  sprites, ids, release order, crew), the area radius for every cell, and 3D voxel overlap between different projects
  (fills, clears and sprites). Map rules: flush Rock paving with a foundation of depth 1 to 2, at least two stages per project,
  no crew, listed in the catalogue, one connected network, every work site within 4 blocks of it, street lamps within 12 blocks
  of every paved cell, all six paving colours and six gateways present.
* `tests/veloren-map.test.js` runs that script, repeats the overlap and budget arithmetic independently in JavaScript, runs
  NemoWorld's validator and the game's `nemo-world-check` (skipped when the binary is absent) and checks the map stays peaceful.
* `python3 tools/preview-harr.py` rewrites `evidence/look/` and `evidence/map/` from the manifest.

Current numbers: 264 groups (129 works, 135 map) of 300; 34336 of 60000 blocks (air clears and foundation columns counted,
as the Rust validator does); 0 overlaps; 1 connected network of 1726 paved cells and 736 kerb cells.

## Risks and what is not verified

* Nothing here has been seen in the game. Both validators and the tests prove the file is legal and self-consistent, not that
  it looks right in Veloren.
* Ground height is measured once per group at its anchor. A stage 12 cells long can span a slope: the 2-block clearing trims
  a bump of up to two blocks and the depth-2 foundation fills a dip of up to two blocks, but a steeper step will leave a
  buried or floating cell. If terrain proves steep somewhere, lower `SEG` in `tools/gen-harr-network.py` and regenerate.
* The `Sign(Ori(n))` orientation values are a guess at which way a sign faces; the manifest accepts them, but whether a sign
  faces the branch it points to is unconfirmed.
* Veloren's own world generation may have put trees, water or cliffs on a route. Clearing removes trees in the 3 x 3 corridor
  and 2 blocks up; a group whose anchor is on liquid or has no ground is refused by the server for good (it logs why).
* Existing works are untouched except the lantern-path fix. The lantern path's own foundation never shows (foundations only
  fill air below the floor); the east trunk now lays real paving along it.
