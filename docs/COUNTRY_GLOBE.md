# Country research globe

The country atlas now offers an orthographic globe and the existing flat map. The globe uses the same pinned Natural Earth map-unit outlines, M49 names and retained agriculture-series coverage colours. Only its front hemisphere is visible. The complete native selector keeps all 248 directory entries accessible, including 73 without outlines at this scale.

## Navigation

Rotate east or west, tilt north or south, or reset the globe with buttons. Arrow keys rotate the focused globe without moving an agent. Selecting a mapped country or using Center globe on country points the view toward its largest mapped polygon. This approximate geometric center is not an official location or capital. Outline clicks retain country research and evidence actions. Focus outline switches to the flat map and its existing bounded zoom.

There is no automatic rotation or new network/tile service. Selection and projection are local display state; they create no country affiliation, task, claim, adoption or coin award. Simplified de facto outlines remain orientation aids, not legal boundaries, measurements or country outcomes.

## Geometry and libraries

The renderer reconstructs spherical coordinates from the retained simplified paths, keeps disconnected polygons and holes, and normalizes winding to avoid drawing country complements. D3 orthographic projection clips the far hemisphere and resamples spherical edges. The source outlines and their original SHA256 remain unchanged.

Geographic math is a 23,731-byte local ESM bundle: d3-geo 3.1.1, d3-array 3.2.4 and internmap 2.0.3. Official npm tarballs were checked against registry SHA512 integrity before extraction. No package install scripts ran. Sources were bundled with esbuild 0.28.0; ISC notices and a pinned source manifest are included. See assets/vendor/GLOBE-LICENSES.txt and globe-source-manifest.json. Original download and bundle checks are in globe-library-source-verification.json.

Projection documentation: https://d3js.org/d3-geo/azimuthal#geoOrthographic

## Verification

All 223 local tests passed. New checks cover spherical ring closure, disconnected France/Corsica and French Guiana separation, South Africa's hole, country orientation, hemisphere clipping, bounds at poles/date line, pinned bundle hashes/licences, read-only routes and unchanged saved research/coin state.

Actual isolated browser QA verified arrow and button rotation, Nepal selector orientation, an India outline click, India flat focus and Singapore's no-outline research fallback. At 390 pixels, page width remained 390 and the globe fit at 316 pixels. The temporary viewport was reset and the fixture closed. These checks validate the observed interface, not legal geography, all-device acceptance or new country research findings.
