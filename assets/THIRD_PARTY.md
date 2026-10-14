# Bundled open source assets

Downloaded from the npm registry over verified HTTPS on 2026-10-11. Selected font files, SVG icons and the pinned Three.js renderer are bundled locally. Original font and icon files are retained with their licenses. `manifest.json` records SHA-256 hashes of the vendored files.

| Asset | Source version | License and notice |
| --- | --- | --- |
| DM Sans, Latin variable WOFF2 | [`@fontsource-variable/dm-sans` 5.3.0](https://www.npmjs.com/package/@fontsource-variable/dm-sans) · [original font project](https://github.com/googlefonts/dm-fonts) | SIL Open Font License 1.1; [full license](fonts/LICENSE-dm-sans.txt) |
| Space Grotesk, Latin variable WOFF2 | [`@fontsource-variable/space-grotesk` 5.3.0](https://www.npmjs.com/package/@fontsource-variable/space-grotesk) · [original font project](https://github.com/floriankarsten/space-grotesk) | SIL Open Font License 1.1; [full license](fonts/LICENSE-space-grotesk.txt) |
| Selected Lucide SVG icons | [`lucide-static` 1.55.0](https://www.npmjs.com/package/lucide-static) · [original icon project](https://github.com/lucide-icons/lucide) | ISC; certain icons derive from Feather under MIT. Both notices are included in [the full license](icons/LICENSE.txt). |

These assets are served locally under the application's content security policy. Latin fonts fall back to the user's system fonts for other scripts. No font or icon service receives browser requests.

## Resident art: faces and standing figures

Added 14 October 2026 for the interface layers that name a resident — the profile card, the resident
roster, the civic and ambassador views, the character picker and the first-play guide. Both sets are
CC0 1.0 Universal. Every file's source, licence, notice, byte size, pixel size and SHA-256 is recorded
in [`residents/manifest.json`](residents/manifest.json); [`residents/NOTICE.md`](residents/NOTICE.md)
is the same record in prose, including the exact crop rectangle for each derived face.

| Asset | Files | Source | License and notice |
| --- | --- | --- | --- |
| RPG portraits, 9 heads in 3 palettes | 27 × 32 × 32 PNG, cropped from one sheet | [OpenGameArt](https://opengameart.org/content/rpg-portraits) · [sheet](https://opengameart.org/sites/default/files/rpgportraits.png), SHA-256 `234ccba3…c4ff1` | CC0 1.0 Universal, author Buch. Attribution is not required; the author asked to be credited as Buch, so he is. |
| Tiny Dungeon standing figures | 10 × 16 × 16 PNG, copied byte for byte | [Kenney](https://kenney.nl/assets/tiny-dungeon) · `kenney_tiny-dungeon.zip`, SHA-256 `c109438a…bb5fc7` | CC0 1.0 Universal, author Kenney. [Original notice](residents/licenses/kenney-tiny-dungeon-License.txt) retained. |

These are served from `/assets/residents/` through the server's own static file map, so no asset host
receives a browser request. They are third-party art, not project-authored work: the mapping from a
resident's stored id to a face and a figure is original project code and is recorded separately in
[docs/handoff/task-character-art.md](../docs/handoff/task-character-art.md).

## Three.js voxel renderer

Three.js 0.186.1 is retained locally under the MIT license. The pinned npm package integrity, source and final bundle hash are recorded in [the source manifest](vendor/three-source-manifest.json); [the original license](vendor/THREE-LICENSE.txt) is retained. The terrain, block structures and parcel overlays are original project code. No Minecraft assets are included.
