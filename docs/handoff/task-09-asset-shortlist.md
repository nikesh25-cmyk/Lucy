# Task 09 handoff — licensed open assets shortlist

Branch `task-09-asset-shortlist`, worktree
`work/t09`. Written 2026-10-12.

## Deliverables

| File | What it is |
| --- | --- |
| `docs/research/ASSET_SHORTLIST.md` | Readable review: what was searched, the strongest candidates per category, what was rejected and why, usable assets separated from study-only visual references, unresolved-rights register, evidence index |
| `docs/research/ASSET_SHORTLIST.json` | Machine-readable manifest, **25 candidates** in 6 categories (`vegetation` 5, `architecture` 4, `furniture` 4, `ui_icons` 4, `avatar_variants` 3, `ambient_audio` 5), each with the 12 required fields plus the 3 requested evidence fields |
| `docs/handoff/task-09-asset-shortlist.md` | This brief |

Nothing was integrated, downloaded, extracted or converted. `outputs/Lucy` was not touched. The
only files added are these three (plus their new directories, `docs/research/`).

## What was verified, and how

Licences were read only at the rights holder's own document or page: a `LICENSE` / `COPYING` /
`LICENSE.txt` in the official repository, or the rights holder's own asset/terms page. Badges,
blogs, wiki summaries and third-party "CC0 list" pages were never used as evidence, and no engine
licence was extended to its bundled media.

Checked 2026-10-12, with the exact URL recorded per candidate in `license_verified_at_url`:

- **Kenney** (`kenney.nl`) — 11 asset pages read directly; each states "License Creative Commons
  CC0" and links the CC0 1.0 deed. Download sizes were measured with HTTP HEAD against the
  publisher's own `.zip` endpoints (nothing was fetched).
- **KayKit / Kay Lousberg** — CC0 read from the publisher's own `LICENSE.txt` inside the official
  `KayKit-Game-Assets/*` repositories for Adventurers, Medieval Hexagon, City Builder Bits,
  Furniture Bits, Restaurant Bits and Dungeon Pack; the Forest Nature Pack is itch-page-only.
- **Quaternius** — the publisher's own licence page is now **Quaternius Asset License (QAL) v1.0**
  ("Last updated: 8/28/2026"), not CC0. Recorded as a custom licence with a redistribution
  restriction, not as an open licence.
- **OpenGameArt** — per-item licence field read on the item pages (free vegetation pack, forest
  ambience, contemplation); the vegetation pack also publishes triangle counts per LOD.
- **Freesound** — CC0 statement read on the individual sound page (Rain_Ambience, VanEngelen),
  including duration/format/size metadata.
- **Luanti** — `minetest_game/LICENSE.txt` (27,103 bytes) read at raw.githubusercontent.com: media
  CC BY-SA 3.0 with per-file exceptions, code LGPL-2.1-or-later. The engine licence does not cover
  the media.
- **Terasology** — the engine README's project-level statement (Apache-2.0 code, CC BY 4.0 artwork
  "unless indicated otherwise - see credits for minor exceptions") was read, **and** the modules
  that carry their own `LICENSE` were separated from those that do not. `ChrisVolume1OST` and
  `LegacyMusic` carry Apache-2.0 `LICENSE` files beside their `.ogg` tracks.
- **Icons** — Lucide `LICENSE` (ISC), Material Design icons `LICENSE` plus README §License
  (Apache-2.0), game-icons `license.txt` plus the site's licence page (CC BY 3.0 with per-contributor
  CC0 exceptions).
- **Renderer constraints** — confirmed in-repo: `assets/vendor/three-voxel.js` exports 27 symbols
  with no `GLTFLoader`, `OBJLoader` or `TextureLoader`; no audio subsystem exists in `app.js`,
  `server.js` or `src/`; the CSP is `default-src 'self'`, which already permits same-origin media.

## What could NOT be verified

1. **Terasology PlantPack** — the only candidate recorded with
   `license_verified_from_publisher_file: false`. The module has no `LICENSE`, `COPYING` or credits
   file, and no licence in `module.txt`. Marked study-only; do not integrate.
2. **Quaternius Ultimate Modular Men Pack** — QAL v1.0 §3a forbids redistributing the assets "as
   assets". Whether serving the model files from a browser app is such a redistribution is
   ambiguous, so it is flagged as not integrable without clarification. Older CC0 claims are
   superseded and no current CC0 statement exists. The pack page also shows its licence only as an
   image, and the URL slug disagrees with the displayed pack name.
3. **Per-file terms inside archives** — for every Kenney and KayKit candidate, the licence was read
   from the publisher's own page/repository file, but the `License.txt` **inside** the distributed
   archive was not inspected, because inspecting it requires a download that this task forbids.
   This is stated per candidate in `unresolved_rights`.
4. **Paid tiers** — KayKit EXTRA/SOURCE and Quaternius SOURCE files are separate paid deliveries and
   were not verified; the JSON and MD say they must not be used.
5. **FreePD** — the site announced closure and its catalogue is gone, so the public-domain
   statements for tracks sourced from it can no longer be checked at the source. This is why
   `LegacyMusic` is listed as a visual/study reference rather than a candidate.
6. **Unreachable sources** — Pixabay audio licence and Sonniss GDC returned HTTP 403 from this
   environment; both are documented as rejected rather than silently omitted.
7. **Sizes and polycounts** — no polycount is known for any 3D pack except the OpenGameArt
   vegetation pack, and no download size is known for the itch-hosted KayKit/Quaternius packs.
   These fields say "not published / not measured" rather than carrying an estimate. GitHub's REST
   API rate limit (60 requests/hour, unauthenticated) was exhausted mid-check, so repository-level
   sizes were not all measured.

## Why nothing was downloaded

The task requires "No downloading or integration until a selected package's permission is
verified", and this deliverable is the shortlist that precedes any selection. Downloading a pack
would also be the point at which its internal `License.txt`, formats and polycounts become
checkable — so the shortlist records those as open items instead of assuming them. Additionally,
adopting a mesh pack depends on an unresolved engineering decision (the pinned, hash-verified
Three.js bundle has no model loader and re-bundling was previously rejected), which no asset
download would settle.

## Tests and checks run in this worktree

- `npm run check` — **passed** (`node --check` over all 21 listed files; no output, exit 0).
- `npm test` — **passed: 341 tests, 341 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo** (40.97 s).
  The change adds two research documents and this Markdown brief only, so nothing under test is
  affected; `npm test` does not read `docs/`.

Both commands were run with `work/node-bin` prepended to `PATH` (Node v24.19.0, npm 10.9.8).
`npm run e2e` was not required for a documentation-only change and was not run.

## Follow-ups for the next task

1. Re-read each archive's own `License.txt` at selection time and hash it, as
   `assets/mayors/manifest.json` already does.
2. Decide the geometry question (loader vs authored cube geometry) before importing any mesh pack.
3. If audio is adopted, re-encode WAV/large MP3 sources and add the playback opt-in that no code
   currently provides.
4. The repository has no root `LICENSE` file, so no asset licence can be inherited from the
   project; that owner decision is still open (`docs/CONTENT_DEFINITIONS.md`, handoff
   `docs/handoff/2026-10-12-schema13.md`).
