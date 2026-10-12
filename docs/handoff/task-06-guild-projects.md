# Task 06 — guild projects and bounded cooperation

Branch `task-06-guild-projects`, based on `task-05-quest-chains` (schema 17, 410 tests). Delivered on
schema **18**, 419 tests, 12 HTTP acceptance steps. Nothing in tasks 01, 02, 03, 04, 05 or 07 was
re-litigated.

## What was asked, and what was built

The task asked to extend the existing **calling affiliations** into practical cooperation: a guild
project board, explicit participation, a scoped contribution plan and shared status, with distinct
operators verifying meaningful collaboration. That is `src/guilds.js` (schema 18), the
`/guilds*` HTTP routes, the **Guild projects** interface section and `docs/GUILDS.md`.

## The model: calling vs guild vs project vs role

| Word | What it is | What it is not |
| --- | --- | --- |
| **Calling** | The peaceful vocation the human operator chooses, one of eight; it fixes a guild name, a purpose and two daily objectives. | Not a role, scope, land title, review authority or project membership. |
| **Guild** | The affiliation that follows from the calling (`Explorer → Wayfarers`, `Cultivator → Living Gardens`, …). | Not a table you join, and not a moderator or reviewer body. |
| **Guild project** | A board entry: a guild, a title, a purpose, a scoped plan of 1–6 workstreams, a visibility and a lifecycle. | Not a calling, role, mission, land claim or coin path. |
| **Membership role** | One value inside one project: `organiser` (its creator) or `member`. | Not an account role, moderator right, reviewer right or management right over anyone else's project. |

The separation is structural, not just descriptive:

- `src/guilds.js` never writes `resident_callings` or `calling_receipts`. Creating or joining a guild
  project neither grants nor requires a calling. `tests/guilds.test.js` asserts that an Explorer
  resident can create a **Living Gardens** project that a **Builder** resident joins, and that both
  residents' `resident_callings` rows and the account roles are unchanged.
- A project's guild is chosen by its creator and is independent of the creator's calling.
- The `organiser` role lives only in `guild_participants.role`. It changes no account role and opens
  no privileged route.

## Visibility rules

`guild_projects.visibility` is `public` or `private`.

- **Public** — listed on `GET /guilds` for everyone, readable through `GET /guilds/project?id=`, and
  joinable by any active resident.
- **Private** — `guildProjectRecord()` refuses any caller whose operator is not the project creator's
  (404, not 403, so it does not confirm existence), and the board's SQL filter only lists
  `visibility = 'public'` projects plus the caller's own. An administrator may read a private project
  for installation review.

`share` (private → public) is the only visibility change allowed, enforced by the
`guild_projects_identity_immutable` trigger; a public project cannot be made private again. Tests
assert: anonymous and outsider listings exclude the private project, the name never appears in the
outsider payload, `GET /guilds/project` is 404 for the outsider and anonymously, joining is 404, the
creator sees it, `share` succeeds, and a raw `UPDATE … SET visibility='private'` is refused by the
trigger.

## Participation rules

`POST /guilds/participation` (`join`, `pause`, `resume`, `leave`) writes only
`guild_participants`/`guild_contributions`:

- **join** — adds an active `member`; refused on a closed or archived project, at 100 participants or
  at 12 participations for one character.
- **pause** — a paused resident cannot pledge or submit. Every standing commitment stays recorded and
  is reported as paused (`shared_status.totals.paused_participants`, and the contribution's
  `participant.state`), so the plan is not silently emptied.
- **resume** — back to `active`; refused while the project is closed.
- **leave** — deletes the participation row and **withdraws every `pledged` (unsubmitted)
  commitment**, so no commitment dangles and the plan stops counting a departed resident.
  `submitted`, `changes_requested` and `verified` rows stay as attributed history with
  `participant.state = 'left'`.

The tests assert the exact counts at each step: pausing keeps `totals.commitments` at 1 and adds
`paused_participants: 1`; leaving reports `withdrawn_commitments: 1`, drops `totals.commitments` to 0,
keeps `totals.claims` at 1 and shows one contribution with `workstream_id: 'walk'` and
`participant.state: 'left'`; rejoining is a fresh participation.

## The scoped plan and shared status

A project carries `plan`: one to six workstreams, each with a slug `id`, a `title`, a named
`output_name` and a `scope`. A resident's row for one workstream walks `pledged` → `submitted` →
`verified` (or `changes_requested`), one row per `(project, workstream, resident)`.

No commitment can read as a completed outcome. Every contribution payload carries an `outcome`
object derived from its status:

| `status` | `outcome.code` | `completed` | `verified` |
| --- | --- | --- | --- |
| `pledged` | `pledge` | `false` | `false` |
| `submitted` | `unverified_claim` | `false` | `false` |
| `changes_requested` | `changes_requested` | `false` | `false` |
| `verified` | `verified` | `true` | `true` |

`shared_status` reports `planned_workstreams`, `commitments`, `claims`, `verified_contributions`,
`participants`, `active_participants` and `paused_participants`, plus per-workstream
`committed`/`claimed`/`verified` counts, `verified_workstreams` and `all_workstreams_verified` — and
a `note` that says a pledge is an intention and a submission an unverified claim. A project's status
is only ever `open`, `closed` or `archived`; being fully verified never silently marks it complete.
The database CHECKs enforce the same thing: `(status='pledged') = (submitted_at IS NULL)` and
`(status='verified') = (verified_by_account_id IS NOT NULL AND verified_by_agent_id IS NOT NULL AND
verified_at IS NOT NULL)`.

## How independent verification is enforced

`POST /guilds/verify` is the only way a contribution becomes `verified`. It reuses the distinct-operator
rule that `communityProjectMilestone` already applies in `src/community.js`:

```js
if ([contributor.operator_id, project.creator_operator_id].includes(actor.account.id))
  fail(403, 'A different operator must verify this contribution.');
```

So independence is decided **by operator, never by character**:

- the contributor's own operator is refused;
- a **second character of the same operator** is refused (the task's explicit prohibition on calling
  one operator's several agents an independent review);
- the project creator's operator is refused, including when that operator is the project's
  `organiser` — an organiser has no reviewer right inside its own project;
- an unrelated operator with the ordinary `member` role may verify, whether it is an AI resident or a
  human player.

The rule is also structural after the fact: `verifyGuildRecords()` (run by `validateDatabase` for
`version >= 18`, and again on every backup) rejects a stored row whose
`verified_by_account_id` equals the contributor's `account_id` or the project creator's
`operator_id`. `tests/guilds.test.js` tampers with a verified row, proves `validateDatabase` fails,
restores it, and proves a backup that lost a guild table is refused.

Accepted contributions keep the **original coin rules untouched**. `src/coins.js` was not modified at
all (its diff is empty); `src/guilds.js` imports no coin code and writes nothing to `coin_rewards`.
The tests assert a whole verified guild flow leaves `coin_rewards` empty, `COIN_POLICY.award === 10`
and `operator_daily_limit === 100`, a self-review is still refused with 403, and the same
contributor's independently accepted real contribution still yields exactly one 10-coin receipt with
`balance = 10`. The release harness step 12 repeats the same assertion over the shipped HTTP API.

## No automatic shared land permission

Nothing in `src/guilds.js` writes `land_stewardships`, `land_parcels`, `land_events` or
`frontier_blocks`. `tests/guilds.test.js` proves it end to end: with the administrator's plot
stewarded and one block placed, a second operator joins the project, pledges, submits, and then

- the `land_stewardships` and `land_events` counts are unchanged;
- that operator holds **no** stewardship;
- `frontierBuild` inside the stewarded plot is refused with 403 (the land-stewardship rule);
- that operator's `creator_account_id` has no frontier blocks.

## Roles grant no moderator or reviewer rights

`tests/guilds.test.js` asserts an organiser (account role `member`) is refused with 403 by
`moderate`, `review`, `accountControl`, `questAuthor`, `operations`, `guildProjectManage` on another
operator's project, `guildProjectManage` as a runtime, and `guildProjectCreate` as a runtime. It also
asserts the account role is still `member` afterwards, and that
`GUILD_PROJECT_POLICY.grants_moderator` / `grants_reviewer` / `grants_role` / `grants_land` /
`grants_calling` are all `false`.

## Human and AI residents

`communityAgent()` is reused unchanged, so both a `kind='agent'` resident and a `kind='human'` avatar
take part on the same terms, through an operator session or (for agents) a `contribute`-scoped
runtime. Creating and managing a project is a **session-only** operator decision, like choosing a
calling or beginning a quest chain; a runtime credential is refused with 403. The test suite and the
release harness both drive an AI resident and a human player through join → pledge → submit, and the
harness has the human player perform the independent verification.

## Schema 18

Three additive tables (`guild_projects`, `guild_participants`, `guild_contributions`), two triggers
(`guild_projects_identity_immutable`, `guild_projects_keep_records`), four indexes. No existing table,
column, view or row is rewritten. `src/database.js` refuses a database above 18 and writes
`PRAGMA user_version=18`; `src/recovery.js` accepts versions 1–18 and adds a `version >= 18` block
that requires the tables, the triggers and `verifyGuildRecords(db)`. The account export became
`shared-world-account-v18` with a `guilds` section.

Migration and durability are asserted: a database whose guild tables were dropped and whose
`user_version` was reset to 17 validates as schema 17, opens and migrates forward to 18 with empty
guild tables and the protections restored, and validates as 18 with the same account count; a
guild-bearing database survives `backupDatabase`, `validateDatabase` and a close/reopen with its
verified contribution intact and its audit chain valid. Every hard-coded version assertion in
`tests/` was moved from 17 to 18 (the legacy expectations such as `user_version = 1`, `2`, `6`, `9`,
`10`, `13`, `14`, `15` are unchanged and still assert forward migration).

## Interface and the manual walkthrough

**This repository has no browser automation.** No headless browser, no Playwright/Puppeteer, and the
project rule is no npm dependencies, so **I could not click through this myself**. The UI evidence is
therefore (a) HTTP tests over the real routes asserting the exact payload the renderer consumes
(`tests/guilds-http.test.js`), and (b) source-level assertions that the renderer is wired to those
fields and creates nodes instead of injecting markup (`renderGuildProjects`, `loadGuildProjects`,
`guildProjectCard`, `guildPlanList`, `guildContributionList`, `guildParticipationControls`,
`guildProjectForm`, `guildOutcomeTag`, the `shared_status`/`outcome`/`participation`/`guild_name`/
`visibility`/`workstream` field names, the navigation entry, and `assert.doesNotMatch(source,
/innerHTML/)`). The walkthrough below is **written, not executed**.

Manual walkthrough on a **disposable** database (never the installed copy):

```sh
LUCY_DATABASE=/tmp/guild-check.sqlite PORT=3311 node server.js
```

1. Open `http://127.0.0.1:3311`. Register the first operator (administrator), then open **My
   characters** and create one AI resident. Its calling defaults to Explorer · Wayfarers.
2. In the navigation, open **Guild projects**. Expect the heading *Guild projects*, the paragraph
   that states a guild project is not a calling, role or land claim, and an empty board (*No guild
   project is listed yet…*).
3. Under **Start a guild project**, enter a title and purpose, choose the guild **Living Gardens ·
   Cultivator** (deliberately *not* your Explorer calling), choose **Private**, and enter a plan such
   as `[{"id":"walk","title":"Trace one accessible route","output_name":"A traced route","scope":"Walk and record one route"}]`.
   Press **Create guild project**. Expect a card badged `open` and `private`, with one participant
   marked `organiser`, a pledge/claim/verified metric row of zeros, and the plan with
   `0 pledged · 0 submitted and unverified · 0 independently verified`.
4. Confirm the calling did not change: open **Callings & guilds**. The resident is still *Explorer ·
   Wayfarers* with unchanged experience. Nothing about the project appears there.
5. Register or sign in as a second operator with its own resident. Open **Guild projects**: the
   private project is absent from the board. Browse directly to
   `GET /api/v1/guilds/project?id=<the id>`: HTTP 404 with *This guild project is unavailable.*
6. Back as the first operator, open the project's **Manage this guild project** disclosure and choose
   **Share a private project publicly** with a reason. The badge becomes `public`.
7. As the second operator, reload **Guild projects**. The project is listed. Press **Join this guild
   project**; the card shows two participants and the button row becomes **Pause participation** and
   **Leave this guild project**.
8. Expand **Pledge a workstream**, choose the plan workstream and write a commitment, then press
   **Record a contribution commitment**. Expect a contribution row badged `pledged · not a completed
   outcome`, the pledge counter to read 1, and the verified counter to stay 0. The row's label says
   the pledge is an intention.
9. In that row, expand **Submit this contribution**, paste evidence and (optionally) a source URL, and
   press submit. The badge becomes `submitted · not a completed outcome`; the metric row shows 1
   unverified claim and 0 verified.
10. Try to verify it from both the contributing operator and the project creator: the *Verify as an
    independent operator* disclosure does not appear for either (the renderer only offers it when
    neither the contributor nor the creator belongs to you), and a hand-made
    `POST /api/v1/guilds/verify` returns **403** *A different operator must verify this contribution.*
11. As a **third** operator, create an account and a resident (a human player works), join the
    project, and use **Verify as an independent operator → Verify this contribution**. Expect
    `verified · verified`, the verified counter to rise to 1, and the text *Independently verified
    by …* with the note that this is peer verification, not mission review and never a coin. If the
    second operator has a second resident, watch that it is **not** offered the verification form —
    two residents of one operator are not two operators.
12. Open **Coin wallet** for both residents: both are 0. Open **Land & frontier**: neither operator
    gained a stewardship, and building outside a stewarded plot is still refused.
13. Press **Pause participation**. The commitment stays on the row and the participant is marked
    paused; the pledge counter does not change. Press **Resume participation**, then **Leave this
    guild project**. The unsubmitted commitment is withdrawn (the pledge counter drops), the verified
    row stays with *This participant has left; the recorded contribution stays historical*, and the
    verified counter stays at 1.
14. Press **Archive the project** from the creator's manage disclosure. The project disappears from the
    board and `GET /api/v1/guilds/project?id=<the id>` returns 404.
15. Keyboard and screen-reader checks: every control is an ordinary button reachable with Tab, cards
    are labelled sections, the board has no focus trap and no hidden required field, and the plan and
    contribution lists are ordinary `ol`/`li` structures.
16. Delete the disposable database (`/tmp/guild-check.sqlite`) when finished.

## Changed files

- **New:** `src/guilds.js`, `tests/guilds.test.js`, `tests/guilds-http.test.js`, `docs/GUILDS.md`,
  `docs/handoff/task-06-guild-projects.md`.
- **Extended:** `src/database.js` (schema 18 guard, `GUILD_SCHEMA`, `PRAGMA user_version=18`),
  `src/recovery.js` (accepted versions 1–18, a `version >= 18` block calling `verifyGuildRecords`),
  `src/platform.js` (`initGuilds`, `guildMethods` assigned, `guilds` export section, export format
  `shared-world-account-v18`, `deleteGuilds` in account deletion), `src/community.js` (one word:
  `normalizeSources` is exported so the guild layer validates source links with the same rule),
  `server.js` (five write routes, two GET routes, the two public reads, 201 on creation),
  `app.js` (the Guild projects section, its state, its loader, the navigation entry and icon, and the
  refresh/selection hooks), `package.json` (`node --check src/guilds.js` in the check gate),
  `scripts/e2e-smoke.mjs` (step 12).
- **Version assertions only:** `tests/recovery.test.js`, `tests/mayor-evidence.test.js`,
  `tests/civic.test.js`, `tests/ambassadors.test.js`, `tests/coins.test.js`, `tests/resident-crash.test.js`,
  `tests/resident-state.test.js`, `tests/followups.test.js`, `tests/elevation-http.test.js`,
  `tests/human-players.test.js`, `tests/expansion-http.test.js`, `tests/vocations.test.js`,
  `tests/quests.test.js`, `tests/local-launch.test.js` (current-version expectations 17 → 18 and the
  export format string).
- **Docs:** `docs/API.md`, `docs/CALLINGS.md`, `docs/PEACEFUL_WORLD.md`, `docs/QUESTS.md`,
  `docs/ARCHITECTURE.md`, `HANDOFF.md`, `README.md`.

## Verification

All four gates on the delivered worktree, Node v24.19.0:

```
$ npm run check
> nemoworld@1.0.0 check
> node --check server.js && … && node --check src/quests.js && node --check src/guilds.js && … && node --check src/placement-policy.js
(no output; every file parses)

$ npm test
ℹ tests 419
ℹ suites 0
ℹ pass 419
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0

$ npm run e2e
PASS  12. a guild project board keeps participation explicit, verification independent and guild activity coinless
        201 invite + 201 third operator (role=member) + 201 reviewer resident + 201 human player;
        201 public project (Living Gardens, one organiser) and 201 private project; 404 private
        project for an outsider and anonymously; 200 join for an AI resident and for a human player;
        200 pledge (intention, nothing verified); 200 submit (unverified claim); 403
        self-verification and 403 creator verification; 200 verification by a third operator
        (completed=true, 1 verified); 200 leave (the verified record stays attributed); 0 coins from
        the whole guild flow, the earlier 10-coin acceptance intact  (75 ms)
SUMMARY  12 steps passed, 0 failed
  coins            one fixed 10-coin receipt for an independently accepted contribution; ledger integrity verified
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API

$ node scripts/seal-content.mjs --check
Verified: 86 definitions (20 appearance, 7 block, 29 cosmetic, 3 crop, 27 furniture); 3 support
files; 42 referenced notices and assets.
```

## What this deliberately did not do

- **No calling redefinition.** `CALLINGS`, the eight guilds, the cosmetic ranks, the daily objectives
  and the calling receipt ledger are untouched. A guild project neither grants nor consumes a calling
  or any cosmetic experience.
- **No new authority.** There is no permission, scope, role, moderation power or review power in the
  guild tables. Creating and managing a project is an operator-session action; verification is a peer
  action bounded by the existing distinct-operator rule.
- **No land.** The module never touches the land registry, the frontier or building. Participation is
  not a plot, a stewardship or an access right.
- **No coins and no merit.** `src/coins.js` and `src/journey.js` are unmodified; guild verification
  creates no receipt and no mission merit, and the message says so.
- **No third review system.** Verification is not mission human review. `src/platform.js`'s
  submission/review workflow, its role checks and its independence rule are unchanged, and the only
  route to a real 10-coin receipt is still an independent human acceptance of a real scoped
  contribution.
- **No invitation or membership negotiation.** A private project is creator-only and can only be
  shared, never made private again. There is no invitee list, no approval queue and no transfer of
  ownership.
- **No new content definitions and no new dependency.** A guild project is data, not a sealed content
  item, so the manifest stays at 86 definitions; the UI is vanilla `document.createElement` only and
  `app.js` still contains no `innerHTML`.
- **No real-world claim.** A guild project plans bounded work *inside* NemoWorld. Nothing in the
  model, the narrative strings or the verification wording asserts an external or verified
  real-world outcome.

## Residual risks

- **A private project is a dead end until it is shared.** Visibility is one-way (private → public)
  and there is no invitation mechanism, so cooperation with others must start public. This is a
  deliberate simplification of the privacy model, but it does mean a private project has exactly one
  participant.
- **Verification needs a third operator to exist.** A two-operator installation cannot independently
  verify a contribution made inside the other operator's project — the release harness had to
  register a third operator to do it. Honest, but it makes small installations unable to complete a
  verified guild flow on their own.
- **No notification or inbox.** A submission awaiting verification is only visible to someone who
  opens the board. There is no queue, no alert and no listing of "contributions awaiting your
  verification", so an independent operator may never notice the work.
- **Leaving withdraws rather than preserves intentions.** Withdrawing unsubmitted pledges keeps the
  plan accurate and prevents dangling commitments, but a resident who leaves loses the record that it
  once pledged. Only submitted and verified work is preserved.
- **Boolean-heavy verification state.** A contribution is a single row per workstream per resident, so
  a resident cannot hold two concurrent proposals for one workstream, and there is no history of
  successive submissions (each `submit` overwrites the previous evidence). This mirrors the
  community milestone model, but it is a real bound.
- **Not a security proof.** Nothing here is claimed to be unhackable. A compromised server, direct
  database access or colluding operators are outside this control set, exactly as the existing coin
  policy says. The guild layer adds no new defence; it adds a narrower surface because it grants no
  authority at all.
- **UI behaviour is proved at the payload level, not in a browser.** There is no browser automation in
  this repository and I could not execute the walkthrough above. The renderer's wiring is asserted
  from source and its data contract from HTTP tests, which is weaker than a real browser run.
