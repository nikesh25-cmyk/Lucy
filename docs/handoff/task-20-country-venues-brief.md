# Task 20 handoff — eight country/area venue variants (design brief)

Date: 2026-10-13. Branch: `task-20-venue-brief`, base commit `4fbdff5`
(`review/nemoworld-queue`, schema 18). Worktree: `work/t20`.

This is the **sanctioned design-only slice of Task 20**. It delivers artifacts, not code: a design
brief for eight country/area venue variants and this handoff. The brief itself is
[`docs/briefs/task-20-country-venue-variants.md`](../briefs/task-20-country-venue-variants.md).

## Changed files

- `docs/briefs/task-20-country-venue-variants.md` — new (the brief).
- `docs/handoff/task-20-country-venues-brief.md` — new (this handoff).

No `.js` file, `catalog/`, `scripts/`, `package.json`, `HANDOFF.md`, `docs/VERIFICATION.md`,
`docs/research/**` or `outputs/Lucy` path was touched. `docs/briefs/` is a new directory.

## The eight variants

Assignment uses the entries' catalog positions in `catalog/countries.json` (248 entries) and the
shipped stand formula `(12 + i % 16, 8 + floor(i / 16))`.

| Variant | Country / area | ISO3 | Stand | Documented reference | Primary source (checked 2026-10-13) |
| --- | --- | --- | --- | --- | --- |
| `terraces` | Nepal | NPL | 21,17 | Community forest (CFUGs) + mid-hill terraces | FAO Case Study 1 `ad686e06.htm`; equity caveat from FAO Case Study 2 `ad686e07.htm` |
| `satoyama` | Japan | JPN | 14,15 | Satoyama socio-ecological production landscape | IPSI `satoyamainitiative.org/concept/satoyama-initiative/` (MOE Japan + UNU-IAS) |
| `andenes` | Peru | PER | 23,18 | Andean terraces, *camellones*, *qochas* | FAO GIAHS `.../peru-andean-agriculture/en` |
| `chinampas` | Mexico | MEX | 26,16 | Chinampa raised fields and channels | FAO GIAHS `.../mexico-chinampas-agricultural-system/en` |
| `argan` | Morocco | MAR | 16,17 | Argan agro-sylvo-pastoral system | FAO story on Ait Souab-Ait Mansour (GIAHS 2018) |
| `kaya` | Kenya | KEN | 18,15 | Community-governed coastal sacred forest | National Museums of Kenya, Kaya Kauma Project |
| `fabod` | Sweden | SWE | 18,21 | Summer farming (*fäbod*) + right of public access | UNESCO ICH no. 02109 (inscribed 2024); Naturvårdsverket |
| `reef` | Fiji | FJI | 25,12 | Locally managed marine area (*tabu*) | Weeks & Jupiter, peer-reviewed, PMC4232917 |

Each variant in the brief carries: the reference; the source URL, what the page states and the check
date; a layout/landmark concept; how it stays navigable; and a statement that it is **original
NemoWorld cube geometry** (no licensed art is integrated).

## Integration design (specified, not implemented)

- **Deterministic selection:** a frozen `COUNTRY_VENUE_ASSIGNMENT` map from `iso3` to a variant id,
  with `countryVenueVariant(iso3)` returning `'generic'` for everything unassigned. A pure lookup —
  no randomness, no clock, no database read — so server and renderer agree by construction. A
  hash-based default is explicitly rejected because it would silently re-shape all 248 venues instead
  of leaving 240 on the generic shape.
- **Collision/footprint:** variants use only sealed terrain types and sealed scenery types classified
  in `src/footprints.js`, so `walkable`, `canStep`, `planWalk`, `escapeColumns`, placement validation
  and the renderer all resolve through the one table. The 16 × 16 plaza band must stay fully walkable
  and free of `mass` scenery so any of the 248 stands remains valid.
- **Arrival/exit and the ambassador stand are retained:** `start (20,25)` and the
  `(20,26)` return portal in every variant, and the plaza band as the stand area; entry stays the
  existing Commons directory rule (`src/spaces.js:205`).
- **Fixed invariants:** `kind: 'country'`, 40 × 28, world id `country:<iso3>` (validated by
  `src/recovery.js:118`), and no frontier sector, land parcel, frontier block or `agents.z`
  registration.

## Verified versus proposed

**Verified in the repository (read, not changed):** the eight catalog entries and their stand tiles;
the generic venue invariants in `world.js`, `src/civic-engine.js`, `src/recovery.js` and the
footprints/ambassadors tests; `src/footprints.js` as the single occupancy table; and the asset
shortlist's finding that no licensed pack is a drop-in (the pinned `three-voxel.js` bundle has no
loader and is hash-checked).

**Proposed (design only):** the eight layouts, landmarks, palettes and object vocabularies; the
selector tables and `variant` field; the new `tests/country-venues.test.js`; and the manual
orbit/first-person/text walkthrough.

## Explicit limitations

- **No code.** This task adds Markdown only; it does not implement, render or measure any venue.
- **Nothing is implemented.** The eight variants are described, not built. The remaining 240 entries
  keep the existing generic `makeCountry` shape.
- **No browser check was performed**, and none is claimed. Orbit/first-person/text navigability is a
  verification *plan* (a new test file plus a manual walkthrough); the executable browser suite is
  Task 15.
- **No asset work.** No asset was downloaded, extracted, converted or integrated, and no licence is
  claimed for any venue art. Every variant is original cube geometry.
- **Eight variants are not eight unique venues for 248 entries.** A variant is a shared shape; many
  entries use the same one, differing only by label, ambassador and landmark text.
- **Fictional spaces, not representations.** Events described are documented references used as
  inspiration; the venues claim no territory, government, institution, people or affiliation.
- **Open source gaps:** `whc.unesco.org` (Kenya WHS) and the OECD Fiji report returned HTTP 403 from
  this environment, so Kenya cites the National Museums of Kenya and Fiji cites the peer-reviewed
  article. Both must be closed before implementation, along with the rights questions (no root
  licence; the renderer cannot load a mesh pack without re-bundling and re-hashing).

## Gates run on this branch (real output)

Both were run in `work/t20` with `PATH="$PWD/../node-bin:$PATH"` (Node v24.19.0). Adding Markdown
cannot affect either gate, and both pass unchanged.

- `npm run check` — **exit 0**, no output beyond the command echo.
- `npm test` — **448 tests, 448 pass, 0 fail, 0 cancelled, 0 skipped** (duration 47,707 ms), the same
  count as the reviewed queue base `4fbdff5`.

No migration, no rollback and no schema change: this branch adds two Markdown files and changes no
runtime behaviour.
