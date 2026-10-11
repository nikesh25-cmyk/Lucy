# CC0 Ninja Adventure import

Creator: Pixel-boy / Sparklin Labs. Official creator-linked repository, pinned commit in manifest. Full CC0 license and official README retained. No audio, fonts, weapons, or engine code imported.

Twenty-two character sheets and matching 38×38 facesets are included, so a twenty-person fully animated roster can use IDs 1–22 excluding 4 and 8. Those two extras have only two pose rows. All other selected sheets are 64×112 (4 columns × 7 rows of 16×16 frames).

Columns: down 0, up 1, left 2, right 3. Idle uses row 0. Walk cycles rows 0,1,2,3; rows 0 and 2 are similar rest poses. Rows 4–6 contain additional action poses and should be excluded for peaceful civic walking. `drawImage(sheet, directionColumn*16, walkRow*16, 16,16, x,y,32,32)` is a direct Canvas mapping. Ground anchor is at the center of the frame's bottom edge. Disable smoothing and use integer scaling.

Facesets are single 38×38 portraits. Tileset is 448×640, arranged on a 16px grid. It contains large assembled props that span cells; choose actual source rectangles visually rather than treating every cell as a complete object. Collision remains the server map's authority.

manifest.json records exact repository source URLs, dimensions, bytes and SHA256 for every source file. Assets in this folder have been retrieved; no application integration was performed.
