# NemoWorld asset pool

A licence-verified pool of third-party assets, pulled from the internet and recorded file by file.
Rebuild or verify it with:

```
node scripts/fetch-asset-pool.mjs            # (re)fetch the whole pool
node scripts/fetch-asset-pool.mjs --only audio
node scripts/fetch-asset-pool.mjs --list     # print the catalogue, fetch nothing
node scripts/fetch-asset-pool.mjs --verify   # re-hash what is on disk
```

Every download passes a **licence allowlist** (`CC0-1.0`, `OFL-1.1`, `ISC`, `MIT`, `CC-BY-3.0/4.0`).
An asset whose terms cannot be named **from the artefact itself or from the rights holder's own page**
is refused, and a file that cannot be accounted for is deleted again rather than kept unrecorded.
`manifest.json` records, per item, the source URL, home page, author, licence, notice text, byte size
and **SHA-256**; `index.json` records **every extracted file of interest** — path, extension, byte size
and SHA-256 — inside the rights record of the archive it came from; `NOTICES.md` is the human register.

## Why this is a *pool*, not an integration

The project already decided, with evidence, **not to import third-party 3D mesh packs**
(`docs/ASSET_LIBRARY.md`): the pinned Three.js bundle ships no `GLTFLoader`/`OBJLoader`/`TextureLoader`
(27 symbols), re-bundling the hash-pinned renderer was rejected, and no licensed pack is grid-aligned.
This pool therefore keeps 3D models and HDRIs **staged** (available, not wired in) and integrates only
what the shipped architecture already supports.

## What is in the pool

108 items. Sizes are the archives on disk; "files" counts extracted files of interest.

| Category | Items | Files | Archives | Licence | Source | Integration |
| --- | --- | --- | --- | --- | --- | --- |
| character | 39 | 18,596 | 49.35 MB | CC0-1.0 | kenney.nl, opengameart.org | staged |
| texture | 14 | 106 | 84.97 MB | CC0-1.0 | ambientcg.com | staged |
| audio | 14 | 1,284 | 43.43 MB | CC0-1.0 | kenney.nl, opengameart.org | **14 curated clips integrated** (`assets/audio/`) |
| hdri | 14 | 14 | 20.48 MB | CC0-1.0 | polyhaven.com | staged |
| ui | 14 | 13,931 | 15.23 MB | CC0-1.0 | kenney.nl | staged |
| icons | 5 | 7,998 | 8.24 MB | CC0-1.0, CC-BY-3.0, MIT | kenney.nl, game-icons.net, heroicons | staged |
| font | 7 | 36 | 2.72 MB | CC0-1.0, OFL-1.1 | kenney.nl, google/fonts | staged |
| model-staged | 1 | 3,615 | 10.05 MB | CC0-1.0 | kenney.nl | **staged only — needs a loader** |

`shared_count`-style finite world inventory is untouched: the pool changes no world, land, plot or
sealed-content definition.

## The character library (this expansion's first priority)

The pool was grown character-first, because that is the raw material the world is shortest of.

- **Kenney, CC0 (31 packs; with the eight OpenGameArt packs below, 18,596 files).** Sprite sheets and
  walk cycles (`platformer-characters`,
  `platformer-art-extended-enemies`, `roguelike-characters` — a single 16 × 16 sheet of 450 parts —
  `roguelike-rpg-pack`, `pixel-platformer` and its three expansions, `1-bit-pack`,
  `1-bit-platformer-pack`, `monochrome-rpg`, `monochrome-pirates`, `micro-roguelike`, `tiny-dungeon`,
  `mini-dungeon`, `top-down-shooter`, `rpg-urban-pack`, `shape-characters`), **clothing and avatar
  parts** (`modular-characters` ships `Skin`, `Face`, `Hair`, `Shirts`, `Pants` and `Shoes` as separate
  swappable part folders), features and expressions (`emotes-pack`, 513 emote parts; `googly-eyes`;
  `background-elements`), and 3D character kits including three rigged, pre-animated packages
  (`animated-characters-protagonists`, `-retro`, `-survivors`, plus `toon-characters`,
  `mini-characters`, `blocky-characters`).
- **OpenGameArt, CC0 (8 packs).** `dungeon-crawl-32x32-tiles` and its supplemental pack — the Dungeon
  Crawl Stone Soup sheet family, 9,049 files of players, monsters, items and terrain;
  `ninja-adventure-free-sprite` — one character's ten animations (`Idle`, `Run`, `Attack`, `Jump`,
  `Jump_Attack`, `Jump_Throw`, `Throw`, `Slide`, `Kunai`, `Dead`) exported frame by frame; `Sunny Land`
  (character, enemies, props, GIF previews and a sound folder); `Hero Spritesheets (ARS Notoria)`;
  `Zelda-like tilesets and sprites`; `Tiny Characters`; and `DENZI's CC0 collection`, whose `paperdoll`
  folder holds a male and a female doll as separable `head`, `torso`, `arms`, `legs`, `lefthand`,
  `righthand` and `feet` parts beside its monster sheets.
- **What this library still does not have: a dedicated portrait/faceset pack.** Faces exist here as
  modular parts (Kenney's `Face`, DENZI's paperdoll heads, the emote icons) and as per-frame animation,
  but no CC0 pack with a headline "faceset/portrait" role was added in this pass. The repository's own
  CC0 facesets are the twenty mayor appearances already vendored in `assets/mayors/`, which this pool
  deliberately does not duplicate.

Nothing here is wired into the renderer. The shipped character is the project-authored cube resident
(`src/characters.js`); this pool is the material a future 2D or sprite path would draw from.

## Audio

`assets/audio/` holds 14 curated CC0 clips with their own `manifest.json` and notice: UI
click/confirm/close, grass and stone footsteps, block place/remove, door open/close, a chop, a chime
and three music jingles. This expansion adds the raw material for more:

- **Kenney CC0:** `sci-fi-sounds`, `casino-audio`, and two voice-over packs (142 OGG clips) beside the
  six packs already pooled.
- **OpenGameArt CC0:** `512-sound-effects-8-bit-style` (512 retro effects by SubspaceAudio, i.e.
  Juhani Junkala — the archive names him and carries a `Movement/Footsteps/` folder, the practical
  source for footsteps on more surfaces, impacts and world SFX), `4-chiptunes-adventure` (the same
  author; four OGG loop-ready stage, boss and menu tracks) and two ambient beds (`dungeon-ambience`,
  `crystal-cave-song18`).

## Materials and skies

- **ambientCG CC0:** 14 1K JPG PBR material sets — five added here (leather, glazed terracotta, roof
  tiles, wood floor, plain fabric) beside the original nine (wood, rock, ground, grass, fabric, metal,
  marble, concrete).
- **Poly Haven CC0:** 14 1K HDRIs — eight added here (two pure skies, partly cloudy, pan, sunflowers,
  sunrise, a forest, a night sky) beside the original six.

## UI, icons and fonts

- **Kenney CC0:** nine added UI packs (fantasy borders, adventure, sci-fi, pixel-adventure, RPG
  expansion, pixel input prompts, pixel cursors, crosshairs, minimap) beside the original four, plus
  `game-icons-expansion`, `ranks-pack`, `medals` and `kenney-fonts`.
- **Icon sets as SVG:** `game-icons-icons` (4,239 CC BY 3.0 SVG icons, one directory per contributor —
  the notice names every one) and `heroicons` (2,580 MIT SVG icons at tag `v2.2.0`).
- **OFL fonts:** six families from `google/fonts` at the pinned commit
  `e9678a5385322c63730122ba464765baad83cfd8` — Cinzel, EB Garamond, Inter, IBM Plex Sans, JetBrains
  Mono and Lora — each with its own `OFL.txt` and `METADATA.pb`. They complement, and do not replace,
  the bundled Cormorant and Manrope (`assets/fonts/`).

## The download budget

`--max-mb` (default **150**) is the budget for the bytes *this run downloads*, not the size of the
whole pool. The pool is a growing library: a re-run spends nothing, because an archive already on disk
is not fetched again. The budget is applied in catalogue order, so a capped run is deterministic, and
every skip is printed and recorded in `manifest.json`. This run downloaded **138.77 MB**.

## Rights, honestly

- Every item names its licence **from the archive's own licence file where one exists** (all Kenney
  packs, both icon sets, the Google Fonts OFL) and **from the rights holder's own page where it does
  not** (ambientCG material sets, Poly Haven HDRIs, most OpenGameArt packs). `manifest.json` says which,
  per item, in `notice_source`, and carries the notice text and its SHA-256.
- Attribution to Kenney, ambientCG (Lennart Demes), Poly Haven, OpenGameArt contributors, game-icons.net
  contributors, Tailwind Labs and the Google Fonts designers is recorded as good practice even where
  CC0 does not require it. The CC BY 3.0 and MIT sets *do* require it, and `NOTICES.md` names it.
- This is not legal advice; it records what was verified from the file actually downloaded. Pooling is
  not verification of every file inside every pack — but every extracted file of interest carries its
  own byte size and SHA-256 in `index.json`, and its own archive's rights record.
- Nothing in this pool was traced from, or substitutes for, Minecraft, Luanti or Terasology assets.
- One image got away in a previous pass and is now handled rather than refused: `kenney-crosshair-pack`
  stores `×` in a folder name in a legacy encoding, which Info-ZIP cannot create. The fetcher retries
  such an archive with `bsdtar` instead of dropping an otherwise CC0 pack.
