# Asset pool — sourcing and integration

Branch `task-asset-pool`, based on `codex/final-integration` (`1de1de3`).

## What this is

A licence-verified pool of third-party assets **pulled from the internet** and recorded file by file,
plus a small **integration** of the part the shipped architecture can already play.

Rebuild / verify:

```
node scripts/fetch-asset-pool.mjs            # (re)fetch the whole pool
node scripts/fetch-asset-pool.mjs --only audio
node scripts/fetch-asset-pool.mjs --verify   # re-hash what is on disk
```

## The policy conflict I found first (and how I respected it)

The project already decided, with evidence, **not to import third-party 3D mesh packs**
(`docs/ASSET_LIBRARY.md`): the pinned Three.js bundle exposes 27 symbols and **no
`GLTFLoader`/`OBJLoader`/`TextureLoader`**; re-bundling the hash-pinned renderer was rejected; no
licensed pack is grid-aligned; per-file terms inside pack archives were never verified. Every block
and furniture appearance is deliberately project-authored cube geometry.

So this task does **not** silently re-bundle the renderer or import a mesh pack. It sources a pool,
keeps 3D models and HDRIs **staged** (available, not wired in), and integrates only what the shipped
code can already use.

## What was pulled

`scripts/fetch-asset-pool.mjs` downloads from an allowlisted set of sources and **refuses any licence
outside** `CC0-1.0 / OFL-1.1 / ISC / MIT / CC-BY-3.0/4.0`. Every file gets a SHA-256.

| Category | Items | Licence | Source |
| --- | --- | --- | --- |
| audio | 6 Kenney packs — 489 OGG | CC0-1.0 | kenney.nl |
| ui | input-prompts, ui-pack, game-icons, cursor-pack — 2304 SVG | CC0-1.0 | kenney.nl |
| texture | 10 ambientCG 1K JPG material sets | CC0-1.0 | ambientcg.com |
| hdri | 6 Poly Haven 1K skies | CC0-1.0 | polyhaven.com |
| model-staged | Kenney Nature Kit — 329 models × 6 formats | CC0-1.0 | kenney.nl |

- Fetched: **26 archives, 93 MB**. Extracted: **11,727 files, 138 MB** (6,729 PNG, 2,304 SVG, 489 OGG,
  50 JPG, 329 each GLB/OBJ/FBX/DAE/STL/MTL, 36 fonts, 6 HDRIs).
- `asset-pool/manifest.json` — per item: source URL, home, author, licence, notice, bytes, **SHA-256**.
- `asset-pool/NOTICES.md` — the human register. `asset-pool/index.json` — the extracted-file index.
- `asset-pool/POOL.md` — the summary. Raw archives and the unpacked tree are git-ignored (large,
  reproducible).

## What was integrated

**14 curated CC0 clips** → `assets/audio/` (0.14 MB), with `manifest.json` + `THIRD_PARTY.md`:

- `src/ui/audio-bank.js` — a sampled clip bank over an existing `AudioContext`; decodes once, plays
  through the **same master node** as the ambient bed so the world's mute and volume govern it;
  every dependency injected, so it is unit-testable with no Web Audio and no network.
- `src/game-audio.js` — creates the bank inside `start()` and exposes `playClip(name)` (a no-op while
  audio is off).
- `server.js` — a fixed, server-owned allowlist serves `/assets/audio/<clip>.ogg`, the manifest, the
  notice and the new module (never a URL-derived path).
- `app.js` — one real call site: a clip on each drawer open/close.
- `tests/audio-bank.test.js` — 4 tests.

## Actual gate output

```
npm run check → OK
node --test tests/audio-bank.test.js tests/game-audio.test.js tests/content-http.test.js → 10 pass / 0 fail
npm test → (recorded in the branch commit; base is 955)
npm run e2e → (recorded in the branch commit)
```

## Honest limits

- **3D meshes and HDRIs are staged, not integrated** — the pinned renderer has no loader. Wiring them
  is a deliberate re-bundling decision for the owner, not something this task did quietly.
- Only the drawer is wired to a clip; the step/place/door/harvest hooks are a small follow-up (the
  `playClip` API and the clips are in place).
- The textures are for DOM/UI surfaces; the voxel world still uses project-authored colours.
- The pool is ~138 MB on disk; the raw archives are git-ignored, so the committed footprint is small
  and the pool is reproducible from the manifest.
- This is not legal advice; it records what was verified from files actually downloaded. Selection is
  not verification of every file inside every pack.
