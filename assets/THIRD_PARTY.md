# Bundled open source assets

Downloaded from the npm registry over verified HTTPS on 2026-10-11. Selected font files, SVG icons and the pinned Three.js renderer are bundled locally. Original font and icon files are retained with their licenses. `manifest.json` records SHA-256 hashes of the vendored files.

| Asset | Source version | License and notice |
| --- | --- | --- |
| DM Sans, Latin variable WOFF2 | [`@fontsource-variable/dm-sans` 5.3.0](https://www.npmjs.com/package/@fontsource-variable/dm-sans) · [original font project](https://github.com/googlefonts/dm-fonts) | SIL Open Font License 1.1; [full license](fonts/LICENSE-dm-sans.txt) |
| Space Grotesk, Latin variable WOFF2 | [`@fontsource-variable/space-grotesk` 5.3.0](https://www.npmjs.com/package/@fontsource-variable/space-grotesk) · [original font project](https://github.com/floriankarsten/space-grotesk) | SIL Open Font License 1.1; [full license](fonts/LICENSE-space-grotesk.txt) |
| Selected Lucide SVG icons | [`lucide-static` 1.55.0](https://www.npmjs.com/package/lucide-static) · [original icon project](https://github.com/lucide-icons/lucide) | ISC; certain icons derive from Feather under MIT. Both notices are included in [the full license](icons/LICENSE.txt). |

These assets are served locally under the application's content security policy. Latin fonts fall back to the user's system fonts for other scripts. No font or icon service receives browser requests.

## Three.js voxel renderer

Three.js 0.186.1 is retained locally under the MIT license. The pinned npm package integrity, source and final bundle hash are recorded in [the source manifest](vendor/three-source-manifest.json); [the original license](vendor/THREE-LICENSE.txt) is retained. The terrain, block structures and parcel overlays are original project code. No Minecraft assets are included.
