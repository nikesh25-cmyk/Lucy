# Task 01 — country ambassadors replacing regional mayors

Branch `task-01-country-ambassadors` in the source checkout. Design record and handoff for the civic
migration requested in [docs/deepseek/TASKS.md](../deepseek/TASKS.md) task 01.

Baseline before this work: schema **14**, 341 tests, 0 failures. After this work: schema **15**,
**351 tests, 0 failures**, plus the four release gates (see *Verification* below).

## 1. Identity scheme

`catalog/countries.json` holds **248 countries and areas**. `name`, `m49`, `iso2` and `iso3` are each
unique across all 248, and the catalog is explicitly a statistical list, not a list of sovereign
states. All 248 entries are labelled **"Countries & areas"** in the directory, in the profile and in
the handoff text; nothing describes them as 248 sovereign states.

| Field | Value |
| --- | --- |
| Table | `npc_ambassadors` |
| Primary key | `id = 'amb-' \|\| iso3` (e.g. `amb-NPL`), so the id is stable and derivable |
| Identity columns | `iso2`, `iso3` (UNIQUE), `m49`, `name`, `region`, `subregion`, `ldc`, `lldc`, `sids` |
| Placement | `world_id = 'country:' \|\| iso3`, `sprite`, `x`, `y`, `direction`, `status` (`active`/`paused`), `created_at` |
| Seeding | `Platform#seedAmbassadors()`, `INSERT OR IGNORE`, run on every boot inside `initCivic` |

Exactly one row per catalog entry, created idempotently: after a first boot **and** after closing and
reopening the database the count is 248, `iso3` is unique, and the id set equals the catalog. This is
asserted in `tests/ambassadors.test.js`.

`x`/`y` is a **stand**: the venue plaza is a 16 × 16 walkable band and stand *i* is
`(12 + i % 16, 8 + floor(i / 16))` for the catalog position *i*. All 248 stands are distinct and
walkable, and each sits inside its own venue, so no two ambassadors share a position even though all
248 venues have the same footprint.

Sprites come from the 20 sealed CC0 appearance sheets, assigned `roster[index % 20]`. **Twenty sheets
are reused across 248 ambassadors**: each sheet serves 12 or 13 countries and several countries share
one portrait. No new art was added, and the content seal records this reuse in the appearance notes
rather than implying 248 unique portraits.

## 2. Additive, recoverable migration

The migration is additive and never rewrites history:

- New tables only: `npc_ambassadors`, `ambassador_legacy_map`, `ambassador_conversations`. They are
  created by `CREATE TABLE IF NOT EXISTS` in `CIVIC_SCHEMA` (`src/civic-engine.js`), executed from
  `src/database.js`.
- `npc_mayors` rows are **not** deleted, renamed or rewritten. The 20 guides keep their names,
  positions, sprites and their 2.5 s patrol tick.
- `mayor_conversations` rows are **not** deleted or rewritten. Old rows keep their exact question,
  answer, `country_context` (possibly null) and `source_numbers`, and stay readable.
- Paused states are preserved: when a mapping row is first recorded, a paused `npc_mayors` row hands
  `status='paused'` to its replacement ambassador **once**. A later manual resume is not undone by the
  next boot.
- Receipt hashes, coin receipts, land records and saved world objects are untouched; the audit chain is
  unchanged and `verifyAudit()` stays true.
- `PRAGMA user_version=15`, the refusal guard is `> 15`, and `src/recovery.js` accepts versions 1–15
  and validates the new schema, identities, mapping completeness and conversation references.
  Every hard-coded schema assertion in `tests/` was updated from 14 to 15.

**Compatibility mapping.** `ambassador_legacy_map(guide_id, region_id, ambassador_id, created_at)`
records one row per historic guide. The mapping is deterministic and deliberately arbitrary: the old
guides described ecological territories, not countries, so region index *i* maps to catalog position
`floor(i * 248 / 20)` (0, 12, 24, … 235) — `mayor-highlands → amb-AFG`, and so on. It is recorded in
the database, not computed at read time, and it is readable through the API as
`ambassador.legacy` / `legacy_conversations` and through the legacy `GET /mayors` listing. It is an
alias for history, not a research claim: the mapping asserts nothing about the region's geography.

## 3. Venue strategy

Each catalog entry gets one deterministic generated venue, addressed `country:<iso3>`, produced by
`makeCountry()` in `world.js` — the same pattern as `district:<region>` and `makeDistrict()`. The
`worlds` rows (`kind = 'country'`, 40 × 28) are seeded idempotently next to the ambassador rows, so a
venue always exists when an ambassador does.

**Why this cannot touch the finite frontier.** A country venue is a generated venue of kind `country`,
not frontier land:

- No `frontier_sectors` row, no `land_parcels` row, no `frontier_blocks` row and no `agents.z`
  registration is created for it. `tests/ambassadors.test.js` captures the frontier world count, the
  16,384-plot registry and the sector count before and after walking all 248 venues and asserts they
  are unchanged, and asserts no land parcel has a `country:%` world id.
- The venue is a fully walkable, connected 40 × 28 map (meadow, paths, a plaza and a garden bed, with
  decorative objects off the plaza). Its arrival tile and its return portal are walkable and reachable.
- **Movement.** A signed-in operator's character standing in the **Commons** may enter any country
  venue (`travel` gains a documented `directoryEntry` rule); the venue's own portal returns it to the
  Commons. The Commons is the shared directory hall, so this keeps movement server-authoritative
  instead of inventing 248 portals inside a 96 × 64 map or inventing country land inside the frontier.
- Country venues are excluded from the bounded `GET /worlds` shared list (`kind NOT IN
  ('frontier','country')`) so the 248 rows never bloat the world directory; they are reached through
  the ambassador directory, which returns `world_id` and the venue route.

## 4. Tick cost

Ambassadors **hold a fixed stand**. They carry no `ticks`/`last_tick` counters and are not in the 3 s
patrol loop, so the server never pays 248 write operations every tick for no visible benefit.
`tickMayors()` — and the `mayorTimer` that calls it — is retained only for the 20 historic guide rows.
`tests/ambassadors.test.js` asserts the table has no patrol counters, that a tick leaves the
ambassador stand unchanged, that it still moves the historic guide, and that `server.js` never calls a
`tickAmbassadors`.

## 5. What replaces what

| Concern | Before | After |
| --- | --- | --- |
| Civic identity | 20 `npc_mayors` (one per ecological district) | 248 `npc_ambassadors` (one per catalog entry); the 20 guides remain as compatibility aliases |
| Storage | `npc_mayors`, `mayor_conversations` | + `npc_ambassadors`, `ambassador_legacy_map`, `ambassador_conversations` |
| Country context format | `nemoworld-mayor-country-v1` | `nemoworld-ambassador-country-v1`; the old format stays readable |
| Roster source | `appearancesFor('civic-mayor')` | both roles; `rules.roster_roles = ['civic-mayor','civic-ambassador']`, 20 sheets for 248 ambassadors |
| Answers | region focus, optional country context | the ambassador's assigned country context and its numbered sources, always |
| Directory | twenty district cards | twenty district cards **+** a paginated, searchable country-ambassador directory |
| Wording | "mayor" in navigation, copy, alt text, panels | "ambassador"/"country ambassador"/"regional guide" in all visible text; internal table, route and CSS names kept where compatibility requires |
| Calling labels | NPCs show level-0 "Civic guide" | unchanged, now also for `npc_ambassadors`; ambassadors hold no XP, coins, credentials or authority |

## 6. API

Canonical (registered in `server.js` `gets`, `writes` and `publicRoute`):

- `GET /api/v1/ambassadors` — public, `q` (name/ISO2/ISO3/M49/region/subregion), `group`
  (`ldc`/`lldc`/`sids`), `offset`, `limit` 1–50 (default 20). Returns `catalog` (248, source, the
  countries-and-areas note), `entries`, `total`, `offset`, `limit`, `has_more`, `counts` and
  `excluded`. Paused ambassadors are withheld from the public listing and counted in
  `excluded.not_shown`; only a signed-in admin/moderator may pass `include_paused=1&status=…`.
- `GET /api/v1/ambassador?id=<amb-ISO3>` — public profile: country context (assigned format),
  `research.leads` + `research.lead_total` for that country, the registered evidence routes, the
  `legacy` mapping where one exists, the venue, the remit, and the signed-in operator's
  `conversations` plus preserved `legacy_conversations`. Conversations are operator-private; another
  operator and anonymous callers see none.
- `POST /api/v1/ambassadors/talk` — scope `chat`, signed-in human only. `{ambassador_id, question}`
  uses the ambassador's assigned country context and its retained source numbers automatically. A
  `country_code` that is not that ambassador's country (iso2, iso3 or M49) is refused **400** with a
  message naming the mismatch. The answer states it is a fictional NemoWorld research guide and never
  a government or UN official, and the model prompt repeats that, requires the supplied country
  context and its source numbers, and forbids inventing rules, contacts, approvals, funding or
  endorsement.
- `POST /api/v1/ambassadors/control` — `admin`/`moderator` only: `{ambassador_id, status}` audited as
  `ambassador.paused` / `ambassador.active`. Pausing an ambassador also stops its mapped historic
  guide so the two listings agree; resuming mirrors that.

Legacy aliases (kept working, documented as compatibility aliases in `docs/API.md`):

- `GET /mayors` — the 20 historic guides in the legacy shape, each annotated with `ambassador_id` and
  its replacement ambassador, plus `conversations` (new store, in legacy shape with `npc_id` when a
  mapping exists), `legacy_conversations` (the untouched historic store) and `legacy_alias: true`.
- `POST /mayors/talk` — resolves the guide through the mapping and delegates to `ambassadorTalk`,
  returning `{…, npc_id, legacy_alias:true}`. A supplied `country_code` keeps its historic meaning by
  selecting that country's ambassador; without one the alias keeps its historic context-free answer.
- `POST /mayors/control` — delegates to `ambassadorControl` (which also stops the historic patrol row).
- `GET /mayors/triage` — unchanged advisory triage; still moderator/admin only.

`civicExport` now returns `conversations` (ambassador store), `legacy_conversations` and
`ambassadors`; `deleteAccount` erases ambassador conversations with the historic ones. The account
export format string is now `shared-world-account-v15`.

## 7. Deliberately NOT done

- **No new art.** The 20 sealed CC0 sheets are reused; 248 ambassadors share 20 portraits. No attempt
  was made to imply unique portraits per country.
- **No physical walking route from the Commons into a venue.** Entry is the documented directory rule
  from the Commons plus the venue's return portal; there is no per-venue gate on the Commons map and no
  invented corridor through the finite perimeter.
- **No ambassador patrol, schedule, ceremony or per-country audio.**
- **No country-specific research content.** Country context reuses the existing retained agriculture,
  electricity-access and Internet-use series plus the country's existing `research_leads`. Ambassadors
  make no claim that these series describe a whole country's economy, buyers or law.
- **No removal of the historic guides, their conversations, or the retired mayor wording in historical
  verification documents.** `docs/MAYOR_*.md` describe the pre-migration release and now say so.
- **No browser automation.** There is no browser harness in this repository (nothing drives a real
  browser in the gates), so the UI is verified by the manual walkthrough in section 9 and by the
  server-side tests. The e2e harness exercises the shipped HTTP API, not the DOM.

## 8. Verification

Four release gates, run from the source checkout with `../node-bin` on `PATH`:

| Gate | Result |
| --- | --- |
| `npm run check` | passes (syntax gate; `src/civic-engine.js` and `src/mayor-evidence.js` were added to it) |
| `npm test` | **351 tests, 351 pass, 0 fail** (baseline 341) |
| `npm run e2e` | **10 steps passed, 0 failed** (step 10 is the new ambassador step set) |
| `node scripts/seal-content.mjs --check` | `Verified: 86 definitions (20 appearance, 7 block, 29 cosmetic, 3 crop, 27 furniture); 3 support files; 42 referenced notices and assets.` |

New test file `tests/ambassadors.test.js` (10 tests) covers: one ambassador per catalog entry after
boot and restart; distinct stands in generated venues with the frontier registry unchanged; the fixed
stand versus the retained patrol; paginated + searchable directory with paused entries withheld and
honest counts; automatic country context, source numbers and the refused country mismatch; profile
research links, legacy mapping and conversation privacy; a v14 database with historic conversations and
a paused guide migrating forward with its history readable; CLI backup/verify plus restore round-trip;
NPC refusals (credentials, XP, coins, review, moderation); and legacy-versus-canonical HTTP
compatibility. `scripts/e2e-smoke.mjs` gained a hermetic ambassador step: paginated listing over 5
pages, a successful talk with country context, a refused mismatch and the legacy listing.

## 9. Browser walkthrough (manual, disposable database)

There is **no automated browser harness** for NemoWorld. This is the explicit manual procedure on a
**disposable** database; it never touches the installed app in `outputs/Lucy` or its database.

```sh
cd work/Lucy-repo
export PATH="$PWD/../node-bin:$PATH"
export LUCY_DATABASE="$(mktemp -d)/world.sqlite"
npm run local            # or: node server.js   (opens http://127.0.0.1:3000)
```

1. **Create a disposable account.** Open the page, choose *Create account*, register an adult account,
   then create one agent character (default calling: Explorer).
2. **Directory.** Open **Regions & ambassadors** in the sidebar. The *Country ambassadors · one per
   catalog entry* panel loads page 1 (20 of 248). Confirm the heading says countries **and areas**, not
   sovereign states.
3. **Pagination.** Press *Next page* four times; the footer counter reaches 248 and *Next page*
   disables on the last page. Press *Previous page* once and confirm the earlier rows return.
4. **Search and grouping.** Type `Nepal` in *Search* and submit — one card remains. Clear it, choose
   *Least developed countries (LDC)* and submit — the total matches the catalog LDC count (44).
5. **Talk.** On the Nepal card press *Talk to this ambassador*. The dialog title is the ambassador's
   name and the sub-line says the country context is fixed. Ask "Help me research agriculture." The
   reply states it is a fictional NemoWorld research guide that does not represent Nepal, any
   government or the UN, and an expandable *Nepal · retained country context* panel lists five numbered
   sources with exact values, observation years, dataset updates, SHA-256 hashes and licences.
6. **Mismatch refusal.** In a second tab open the browser console and run
   `await fetch('/api/v1/ambassadors/talk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ambassador_id:'amb-NPL',question:'Agriculture?',country_code:'BD'})}).then(r=>r.status)`
   — it returns **400** and the JSON error names the country mismatch.
7. **Venue.** Press *Visit country venue* on the Nepal card: the view switches to `country:NPL`, the
   venue name is "Nepal research venue", and the ambassador appears as a resident standing on the
   plaza. With your character selected, use the world control to enter the venue from the Commons
   (`travel`), then walk to the venue portal to return. Confirm the map is 40 × 28 and the frontier
   land panel is unchanged.
8. **Profile.** Press *Open profile*: the profile shows the country context, five registered evidence
   routes with definition/metadata links, the research-lead count, and your private conversation
   history. Sign in as a second account and confirm it shows no conversations from the first account.
9. **Legacy alias.** Still signed in as an operator, open the *Regions & ambassadors* district cards and
   press *Talk to this ambassador* on **Highlands**; the dialog notes the compatibility alias
   `mayor-highlands` and its historic messages remain readable.
10. **Moderator control.** Sign in as a moderator (or invite one), pause an ambassador from a district
    card (*Pause ambassador*), and confirm the paused entry disappears from the public directory and
    that `GET /api/v1/ambassadors` reports `counts.paused` honestly.
11. **Restart.** Stop the server, start it again with the same `LUCY_DATABASE`, and confirm the
    directory still reports 248 entries and your conversation history is intact.

**This walkthrough has not been executed by an automated harness in this task, and it is not claimed
as browser-verified.** The equivalent server-side behaviour is covered by `tests/ambassadors.test.js`
and the e2e step.

## 10. Residual risks

- The legacy mapping is arbitrary. A reader could mistake `mayor-highlands → amb-AFG` for a geographic
  claim; the mapping is documented as an alias only, and no content derives meaning from it.
- `GET /ambassadors` reads all 248 rows and filters in memory. That is a fixed, small bound today
  (248 × ~200 bytes), but it would need a SQL-side filter if the catalog grew by orders of magnitude.
- The country venue is a single generated shape shared by 248 worlds. It is honest but visually
  repetitive; per-country geometry would need authored or licensed art (task 09).
- The directory's public/private boundary rests on role checks in `ambassadors()`; a future change to
  that method must keep returning paused entries only to a moderator.
- `ambassadorControl` pauses both the ambassador and its mapped guide. If a future release removes the
  historic guide rows, the mirrored update must be removed with them.
- The Commons directory-entry rule for country venues is a deliberate simplification: it lets any
  character in the Commons enter any country venue. Restricting it further would need a new venue
  gateway concept.
- Doc drift: `docs/MAYOR_ROSTER.md` and `docs/MAYOR_EVALUATION.md` remain historical records of the
  pre-migration release, marked as such at the top.
