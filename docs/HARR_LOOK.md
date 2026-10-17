# Harr Architectural Design Language & Public Works Specification

## 1. Architectural Philosophy & Vision

Harr is a peaceful, cooperative, and forward-looking village built inside Veloren as part of NemoWorld. Its architecture reflects growth, scholarship, shared abundance, and care rather than defense, fortress walls, or conquest.

- **Zero Combat/Fortress Elements**: There are no watchtowers with arrow slits, perimeter battlements, or moats. Vertical structures are research towers, observatories, vertical agricultural facilities, and wind harvesters.
- **Shared Commons & Transparency**: Buildings feature open colonnades, wide welcoming doorways, glass light wells, communal reading decks, and benches facing public squares.
- **Ecological Harmonization**: Structures step gently into the terrain, combining clean composite pale rock, steel framing, local stone, and solar glass with lush flowering planters and green turf commons.

---

## 2. Materials, Textures, and Color Palette

The futuristic palette combines high-durability composites with clean energy harvesting surfaces:

| Material Name | Block Kind | RGB Code | Architectural Usage |
| :--- | :--- | :--- | :--- |
| **Composite Pale Wall** | `Rock` | `[210, 215, 220]` | Main structural walls, column piers, podium facings |
| **Teal Glazed Roof** | `Rock` | `[50, 150, 160]` | Stepped domes, canopies, eave accents, weather hoods |
| **Galvanized Steel Deck**| `Rock` | `[120, 130, 140]` | Inter-floor decks, maintenance walkways, structural beams |
| **Dark Solar Glass** | `Rock` | `[30, 70, 115]` | Solar arrays, south-facing solar skylights, energy collectors |
| **Sky Glass** | `Rock` | `[120, 190, 215]` | High-transparency greenhouse domes, observatory windows |
| **Dressed Ashlar Stone**| `Rock` | `[140, 145, 150]` | Sub-foundations, water basins, retaining walls, bridge abutments |
| **Warm Planed Timber** | `Wood` | `[140, 95, 55]` | Interior tables, seating tiers, craft counters, study desks |
| **Living Commons Turf** | `Grass` | `[110, 175, 75]` | Festival commons, amphitheatre lawn, planter bed fill |
| **Sub-grade Soil** | `Earth` | `[110, 84, 60]` | Sub-surface foundation anchors |

---

## 3. Lighting, Fenestration & Proportions

1. **Illumination Lines**:
   - Pathways and public squares feature embedded lantern markers and raised lamp arches spaced every 6 to 10 blocks.
   - Buildings incorporate `Lantern` sprites at every main portal and at corners of elevated observation walkways.
2. **Fenestration**:
   - Standard openings use `Window1`, `Window2`, `Window3`, and `Window4` sprites embedded directly into pale composite and stone envelopes, ensuring natural light penetrates reading halls and workspaces.
3. **Proportions & Silhouettes**:
   - **Podiums**: 1–2 blocks above natural grade with shallow access steps.
   - **Towers**: Tall, slim vertical silhouettes (e.g. Research Tower, Water Tower, Vertical Farm) with stepped upper viewing platforms and solar crowns.
   - **Domes & Vaults**: Shallow tiered domes (Amphitheatre, Seminar Pavilion, Glass Garden) preserving clear sightlines across the valley.

---

## 4. Districts & The 36 Public Works Projects

Harr is organized into distinct functional quarters surrounding the central square:

### Central Plaza & Foundational Works
1. `well` (5m, Plaza:0): Stepped circular fountain and freshwater basin.
2. `market-hall` (15m, Plaza:0): Timber-beamed pavilion for communal exchange.
3. `observatory` (50m, Plaza:0): Stepped stone platform for celestial observation.
4. `lantern-path` (70m, Plaza:0): Lit stone pedestrian spine connecting square to fields.
5. `field-pavilion` (95m, FarmField:0): Shaded rest pavilion for agricultural scholars.
6. `library-annex` (110m, House:0): Extension archive with double-sided book stacks.
7. `orchard-gate` (140m, FarmField:1): Low enclosing boundary and entrance gateway.

### Innovation District
8. `research-tower` (20m, Plaza:0): Slim 17-block glass-banded tower with research decks.
9. `solar-array` (40m, Plaza:0): Dual-angle photovoltaic banks feeding village night grids.
10. `vertical-farm` (80m, FarmField:1): Stacked 12-block hydroponic greenhouse tower.
11. `light-fountain` (60m, Plaza:0): Concentric stone and water basin illuminated by lamp posts.
12. `transit-hub` (105m, Workshop:0): Cantilevered passenger platform with light canopy.
13. `data-archive` (150m, Workshop:0): Long glazed archive hall preserving open knowledge.
14. `sky-walk` (130m, Plaza:0): Elevated aerial walkway spanning the eastern plaza.
15. `glass-garden` (175m, House:0): Tiered geodesic greenhouse dome warm in every season.

### District 1: Learning Quarter
16. `schoolhouse` (10m, Workshop:0): Two-storey brick and timber center for botany and history.
17. `seminar-pavilion` (30m, Workshop:0): Circular open colonnade for philosophical dialogues.

### District 2: Making Quarter
18. `workshop-hall` (45m, Workshop:0): Craft hall with visible forge-free ceramic and textile benches.
19. `recycling-garden` (65m, Workshop:0): Stone sorting bays for material reclamation and reuse.

### District 3: Living Quarter
20. `cottage-1` (35m, Plaza:0): Original pioneer stone cottage.
21. `cottage-2` (85m, Plaza:0): Second pioneer residence with timber decking.
22. `cottage-3` (125m, Plaza:0): Third pioneer residence with herb planter boxes.
23. `cottage-4` (75m, Plaza:0): Split-level eco-cottage with solar skylight (Style A).
24. `cottage-5` (100m, Plaza:0): Split-level eco-cottage with split mezzanine (Style A).
25. `cottage-6` (155m, Plaza:0): Split-level eco-cottage with upper balcony (Style A).
26. `cottage-7` (115m, Plaza:0): Stepped dome eco-cottage with floral planters (Style B).
27. `cottage-8` (145m, Plaza:0): Stepped dome eco-cottage with curved masonry (Style B).
28. `cottage-9` (165m, Plaza:0): Stepped dome eco-cottage with reading nook (Style B).
29. `guesthouse` (55m, House:0): Hospitable lodge welcoming newcomers with hot tea and beds.

### District 4: Gathering Quarter
30. `amphitheatre` (90m, Plaza:0): Sunk-stone acoustic bowl for evening storytelling circles.
31. `festival-lawn` (120m, Plaza:0): Broad grass commons bounded by glowing teal lamp arches.

### District 5: Water & Energy Quarter
32. `water-tower` (105m, FarmField:0): High-head stone and steel pressure tower for irrigation.
33. `solar-field-2` (135m, Plaza:0): Expanded southern collector field powering deep grid storage.
34. `wind-array` (160m, Plaza:0): Trio of silent vertical-axis wind turbines on the ridge.

### District 6: Transport Quarter
35. `canal-bridge` (25m, Plaza:0): Arched ashlar stone footbridge over the western waterway.
36. `tram-halt` (170m, Plaza:0): Waiting pavilion and timetable platform for regional transit.

---

## 5. Furnished Interiors for Key Public Buildings

Every major civic building includes readable, game-scaled interiors assembled from verified sprites:

1. **Library Annex (`library-annex`)**:
   - `Chest` sprites for scroll and document storage.
   - Double `TableCoastalLarge` reading tables flanked by `BenchWoodWoodland`.
   - Corner `Planter` boxes bringing fresh vegetation indoors.
   - Ambient `Lantern` illumination mounted at head height.
2. **Research Tower (`research-tower`)**:
   - Ground level study desk (`TableCoastalLarge` with `BenchWoodWoodland`).
   - Mid-level astronomical instrumentation (`Orb` representing the crystal cartographic sphere).
   - Top-tier open viewing deck with panoramic perimeter `Window4` fenestrations and telemetry lanterns.
3. **Open Archive (`data-archive`)**:
   - Four dedicated index desks with scholar seating.
   - Wall-mounted documentation cabinets (`Chest`).
   - Twin central display pedestals with illuminating lanterns.
4. **Harr Schoolhouse (`schoolhouse`)**:
   - Front instructor station with lecture lectern and demonstration desk.
   - Dual student bench rows (`BenchWoodWoodland` facing wide study tables).
   - Side herbarium planter bins (`Planter`) for hands-on botany lessons.
   - Welcoming entrance signpost (`Sign`) greeting students.
5. **Travellers' Guesthouse (`guesthouse`)**:
   - Communal hearthside dining table with four benches.
   - Clean guest bunks with reading lanterns.
   - Herbal tea and provision pantry chests.
   - Welcoming hospitality marker (`Sign`).

---

## 6. Verification & Structural Bounds

All structures are generated through `tools/gen-harr-works.py` and strictly validated:
- **Zero Voxel Collisions**: The generator runs an automated 3D voxel collision detector across all 36 projects and all 125 stages, ensuring no two projects claim conflicting spatial volumes.
- **Budget Compliance**:
  - Total Manifest Groups: 129 (well within the hard cap of 300).
  - Total Placed Blocks: 7,185 blocks (well within the hard limit of 60,000 blocks).
  - Area Boundary: Radius 110 (within max allowed radius of 150).
- **Dual Validator Approval**:
  - Full pass on Node.js validator (`tests/veloren-world*.test.js`).
  - Full pass on Rust compiler validator (`nemo-world-check`).
