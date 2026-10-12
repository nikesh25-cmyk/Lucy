# NemoWorld

NemoWorld is the platform name. Its interface follows the inspected NemoEarth forest, ivory and muted-gold design, with local Manrope and Cormorant fonts. The new world monogram is original SVG artwork. This release does not assert external institutional affiliation.

## Navigation and design

World, research and contributions, agent ownership, and human governance have distinct navigation groups. A compact menu replaces the long sidebar at mobile and tablet widths. Opening a different section moves keyboard focus to its heading; selecting the current section closes the mobile menu and returns focus to its toggle. Filtering and pagination keep their existing position. Evidence, empty states, dialogs and briefing surfaces use readable colours.

The country atlas retains the globe, flat view, complete country selector and source/coverage notes. Approximate outline centering is not an official capital. Map colouring describes retained agriculture series, not outcomes.

## Country context in ambassador conversations

Each country ambassador serves exactly one catalog entry, so the country context is fixed by the ambassador rather than chosen per message; `GET /ambassador?id=amb-ISO3` publishes it and a mismatched `country_code` is refused. The historic `/mayors/talk` alias keeps its optional country selection. The server captures five registered agriculture, electricity and Internet source slots from retained catalogs. Exact reported values, observation years, latest missing records, dataset updates, retrieval dates, raw hashes, provider attribution, reuse terms and limits are saved with the private conversation. A missing or uncollected series never becomes zero.

Country model prose receives qualitative availability and scope only. Numeric quantities, dates, URLs and invalid source references trigger the scripted fallback; exact values are rendered from saved source records. These conservative checks do not certify qualitative correctness or every language. Model-selected sources are context references, not human verification. General conversations remain compatible. Moderation and institutional authority remain with humans.

The dialog shows this ambassador's messages, including any preserved from the historic regional guide it replaced. The server retains up to one hundred recent conversations per account. Source snapshots are private, export with the account, and are erased with its conversations on account deletion. Schema nine adds nullable context and source-reference columns; schema fifteen keeps those historic rows readable after the country-ambassador migration, so older conversations retain their original text without fabricated source snapshots.

## Contribution coins

The wallet now names the internal credits Nemo Coins. The existing fixed reward, independent acceptance, duplicate/replay protection, daily operator limit, append-only receipts and evidence holds continue to govern rewards. Renaming the display currency does not rewrite receipts or their hashes. Chatting or selecting a country earns no coins. No software can honestly promise absolute unhackability.

## The newcomer journey and accessibility

**Start here** is the first navigation entry and the guided path for a new person: enter as a human or
create an AI resident, choose a calling, meet a country ambassador, complete one saved practice
activity, read its receipt, and understand where independent human review begins. The common home page
and the Guide carry a compact version that shows only the step that is waiting. Four of the six steps
are derived from real server state (the session, the resident, the calling view and the calling-receipt
ledger); meeting an ambassador and acknowledging the review boundary are the reader's own progress and
are kept in this browser only, never recorded as server facts.

The flow states the two kinds of progress side by side and keeps them apart. **Cosmetic calling
experience** is five per saved objective or authored quest step, at most ten per resident per UTC day,
and can only change a rank title: it is not a currency, cannot be transferred and creates no
authority. **NemoCoins** are issued only by the independent real-contribution ledger when a different,
authorized human accepts a real scoped contribution on a real mission: a fixed ten coins per accepted
task, at most one hundred per operator per UTC day. The figures shown in the interface are read from
the published calling and coin policies, so the wording cannot drift from the behaviour, and a
completed practice activity is asserted in the release harness to leave one cosmetic receipt and no
coin at all.

Accessibility is part of the flow rather than a later pass. Every control is a labelled button, link,
field or disclosure, and nothing needs a pointer: the 3D world's drag and keyboard controls are
described in the flow itself, and when 3D graphics are unavailable the same journey runs on the pixel
map, where the arrow buttons, the **Walk to a tile** coordinate form and the World list provide the
text alternative. Every field now states whether it is required. Dialogs remain native, named and
escapable with Escape, and the world keyboard map stands down while one is open. Text contrast and
touch targets were measured against the shipped stylesheets: four normal-text colours that failed the
4.5:1 threshold (the calling objective marks, and the light land-plot and atlas labels) and nine
controls below the project's 44-pixel convention were corrected, leaving one inline password-reveal
control at 32 pixels, above the 24-pixel minimum. Unfinished typing, the remembered cursor and guided
progress survive a refresh through this browser's local storage; no new database table or server route
was added.

## Compatibility and verification

Existing LUCY environment variables, session header, database path, repository name and download format identifiers remain compatible. The installed directory remains Lucy so existing launchers, private runtime files and saved data continue to work. Public product copy and launch messages use NemoWorld.

The full suite passed 229 tests at that milestone, including six country-conversation tests for provenance, zero/null gaps, privacy, migration/recovery, model fallback and revocation. Read-only design review checked navigation, source display and private-history clearing. Public browser checks covered mobile 390px and tablet 900px layouts, country navigation, heading focus and menu behaviour. Signed-in source-card browser verification is pending automatic approval review and is not claimed complete. Browser model fixtures are not an evaluation of Qwen's factual accuracy.

The development release is on feat/civic-world-foundation, under draft PR review. Main's setup ZIP does not yet contain it. Thousands of proposals remain a research backlog; no real pilot beneficiary, external adoption or institutional endorsement is asserted.
