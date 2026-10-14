# NemoWorld asset pool

A licence-verified pool of third-party assets, pulled from the internet and recorded file by file.
Rebuild or verify it with:

```
node scripts/fetch-asset-pool.mjs            # (re)fetch the whole pool
node scripts/fetch-asset-pool.mjs --only audio
node scripts/fetch-asset-pool.mjs --verify   # re-hash what is on disk
```

Every download passes a **licence allowlist** (`CC0-1.0`, `OFL-1.1`, `ISC`, `MIT`, `CC-BY-3.0/4.0`).
An asset whose terms cannot be named is refused. `manifest.json` records, per item, the source URL,
home page, author, licence, notice, byte size and **SHA-256**; `NOTICES.md` is the human-readable
register; `index.json` indexes the 9,982 extracted files of interest.

## Why this is a *pool*, not an integration

The project already decided, with evidence, **not to import third-party 3D mesh packs**
(`docs/ASSET_LIBRARY.md`): the pinned Three.js bundle ships no `GLTFLoader`/`OBJLoader`/`TextureLoader`
(27 symbols), re-bundling the hash-pinned renderer was rejected, and no licensed pack is grid-aligned.
This pool therefore keeps 3D models and HDRIs **staged** (available, not wired in) and integrates only
what the shipped architecture already supports.

## What is in the pool

| Category | Items | Licence | Source | Integration |
| --- | --- | --- | --- | --- |
| audio | 6 Kenney packs, 489 OGG | CC0-1.0 | kenney.nl | **14 curated clips integrated** (`assets/audio/`) |
| ui | input-prompts, ui-pack, game-icons, cursor-pack (2304 SVG) | CC0-1.0 | kenney.nl | staged |
| texture | 10 ambientCG 1K JPG material sets | CC0-1.0 | ambientcg.com | staged |
| hdri | 6 Poly Haven 1K skies | CC0-1.0 | polyhaven.com | staged |
| model-staged | Kenney Nature Kit (329 models × 6 formats) | CC0-1.0 | kenney.nl | **staged only — needs a loader** |

`shared_count`-style finite world inventory is untouched: the pool changes no world, land, plot or
sealed-content definition.

## Curated audio integrated into the game

`assets/audio/` holds 14 CC0 clips with their own `manifest.json` and notice: UI click/confirm/close,
grass and stone footsteps, block place/remove, door open/close, a chop, a chime and three music
jingles. See `docs/handoff/task-asset-pool.md` for how they are served and played.

## Rights, honestly

- Every file here is CC0 / OFL / permissive; attribution to Kenney, ambientCG (Lennart Demes) and
  Poly Haven is recorded as good practice even where CC0 does not require it.
- This is not legal advice; it records what was verified from the file actually downloaded.
- Nothing in this pool was traced from, or substitutes for, Minecraft, Luanti or Terasology assets.
- `asset-pool/files/` (the raw archives) and `asset-pool/extracted/` (the unpacked tree) are
  git-ignored on purpose: they are large and fully reproducible from `manifest.json`.
