# Native AI city geometry

Generate with `python3 tools/gen-native-ai-city.py`; `--output-dir DIRECTORY` writes the same three artifacts into a temporary directory for deterministic verification. It edits no existing Harr file. Parent composition owns activation and live survey.

## Contract

- `veloren-ai-city.json`: existing `veloren-world-v1`, `site: Harr`, area radius 400; 55 additive `city-*` groups. All operation offsets remain within ±48, heights within 0..20, and original group/fill/total budgets remain sufficient.
- `veloren-ai-city-projects.json`: existing `nemo-works-v1`, 8 projects, 3 stages, 2 minute gap. Each stage has crew 2, including its foundation. The parent must count native city NPCs exclusively for these groups.
- `veloren-ai-city-landmarks.json`: existing `nemo-landmarks-extra-v1`. Eight main city targets plus four specific home targets, and 8 `site-city-*` construction targets. Each construction target equals its paired building doorstep. Preserve exact `city-*` navigation IDs when composing link config.
- For each project `P`, stages are `P-foundation`, `P-shell`, `P-complete`, released at 1, 3, 5 works minutes, all `site: site-P`. Final residence records are `city-home-1-complete` through `city-home-4-complete`. Only saved native completion establishes a home.
- Parent-authorized area/anchor envelope is 400; this requires corresponding JS/Rust validator integration. Local operation extent 48 and the 60000 total native work-cell cap remain unchanged. Rust counts every unique fill/clear/sprite cell per group plus every foundation column. Original Harr: 304 groups / 34596 work cells. City: 55 groups / 24909 work cells. Combined: 359 groups / 59505 work cells, leaving 495 cells under the cap. The city has 13721 raw fill blocks; fill-only accounting is insufficient. Every fill and clear operation stays at or below 4096 cells, and each expanded group stays below 6000 cells.

## Layout

Coordinates are relative to the resolved Plaza plot, not the Harr site origin. District footprint is x=-68..68, y=174..266; centre about(0,220). Segmented walking approach runs x=-1..1, y=54..215, after the existing cached north props end at y53. A narrow connector at x=0,y52..53 joins the existing paving at y51 and preserves the lamp at (2,53). Centre route x=-1..1 is clear from y54 onward. The public avenue spans y216..224; protected three-block-high clear corridors run along both sidewalks (y216/y224) and the road centre (y220). The north/south street similarly clears x=-3/0/3. Paving uses structural foundation beams; it does not fill every decorative edge column below ground. Northern homes/park/greenhouse and southern civic buildings have clear walkways to it.

Office: 16x18, 19 blocks high, furnished ground level and mezzanine at 7 with actual stairs. University: 16x18, 16 high, mezzanine at 8 with stairs. School: 14x16, 8 high. Four homes: 10x12, 6 high, two beds each, table, storage, cooking prop. Farm: 16x18 greenhouse, 7 high, raised soil/planters, water/storage props. Public park, work yard, existing native street lamps and signs complete the district.

All buildings have three-wide, four-high openings at both ends and clear central aisles. Signs are native sign sprites; their semantic labels live in named landmarks because the existing manifest has no sign-text operation. Architectural glazing/steel uses blue/grey `Misc` blocks plus actual `Window3` sprites and pale stone: the allow-list has no true Glass or Metal block kind. This is an existing-asset architectural approximation, not a transparency/material-system upgrade.

## Verification and remaining native gate

`node --test tests/native-ai-city-content.test.js` covers two-pass byte determinism, existing validator, budgets, all stages/site pairs/crew 2, protected approach and avenue, authored-floor flood-fill connectivity of every destination, three-wide doors, clear room aisles, two beds per home, and headroom on both mezzanine staircases.

Budget revision: the first native dry run rejected the earlier blanket clearing volumes and total native work-cell count before applying the city. The compact revision reduces room clearing to occupied ground/mezzanine headroom and keeps the original hard caps.

These geometry tests share a nominal ground datum. Native terrain must still prove segment elevation joins, foundation depth acceptance and actual walking. Flat buildings sample their doorway ground locally. Eight plain city-*-path groups contain exterior access and precede their building foundations, so workers can approach before construction starts. Parent native integration projects only allow-listed public surface groups (roads, promenade, park, yard and paths) to checked per-column ground, keeps all building stages flat, and persists the bounded projection for consistent restart/reconciliation. Native grade, door threshold joins and movement still require observation. Cached Plaza=(15213,15977), site origin=(15216,16016). With that Plaza, the district maximum x=15281 stays west of native private-home pads beginning at x=15300. Verify actual generated anchors and saved-work/private-pad envelopes before enabling. These tests are not a native screenshot, GUI walkthrough or completed-construction observation.
