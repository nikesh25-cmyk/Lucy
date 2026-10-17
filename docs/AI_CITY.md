# NemoWorld city: guest homes and AI work

The city direction is **AI residents do the work; humans are guests**. Human guests explore, talk and request a home. Operators retain responsibility for permissions, budgets, privacy and independent review.

## Use this release

Open `/city` on the Harr web service (local installation: `http://127.0.0.1:3100/city`). The journal at `/harr` links to it.

1. Browse the existing AI roles, configured residents, saved public works and research.
2. Sign into your existing NemoWorld account. If needed, use the existing `/veloren-link` flow to associate your current human game character once.
3. In **My home**, choose a supported available Commons plot and a roof style. **Ask Rowan to build my home** explicitly requests the free plot and cottage.
4. The page distinguishes a saved request from confirmed construction. A native `command.applied` acknowledgement establishes that the cottage stands. Use the confirmed home's enter/leave buttons or whisper Rowan in game.

Rowan currently uses a scripted cottage blueprint with eight roof styles. The service does not run a model or charge compute. An existing matching claim can be reused; it is not an existing built home merely because the account owns land. New cottages are made private through the existing platform visiting settings. Already requested/confirmed homes keep the owner's chosen visiting settings.

Private access controls the application's room access and the native entry path. It does not make world geometry confidential to a modified game client. Private text and vault contents are not put into native blocks or public city responses.

## Plot measurements and protection

The finite land registry remains unchanged: parcel IDs such as `plot:0:0:1:2`, a 6 × 6 conceptual-unit parcel, one stewardship per operator. Veloren maps that address to a 14-block pitch and a 12 × 12 build pad. The page explains both scales; native blocks are not represented as registry square metres or real property.

Only native-supported Commons plots are offered, after registry reservations, ownership and occupancy filtering. Where a native terrain report is configured, known unsuitable ground is also excluded and checked again before assignment. Final terrain acceptance remains with Veloren.

The native server already writes `<outbox>.home_plots.json`. The service derives that path from `NEMO_WORLD_RECORD=…world.json`, or accepts an administrator-configured `NEMO_HOME_PLOTS` path. No client may supply a file path. A configured report must be at most 65,536 bytes, have spacing 14, and describe all 36 unique supported plots with boolean suitability. Missing/corrupt reports stop new construction requests; existing confirmed homes remain readable and can be entered/left. An installation without a configured report explicitly labels terrain unchecked.

Existing claims and construction are preserved. Neither the page nor Rowan can stamp a native cottage over saved browser construction. Unsupported claims are shown with a recovery explanation; they are never automatically released or reassigned. New home creation issues no NemoCoin or land-payment event.

## Recovery

- **Building:** wait for the saved command's acknowledgement. Repeated requests do not enqueue another pending build.
- **Refused:** the claim remains saved; review the terrain/construction explanation and retry.
- **Unconfirmed:** a command timed out without confirmation. Check the native server before retrying; the interface does not claim construction succeeded.
- **Paused:** new claims/builds/entry stop; a current guest can still ask to leave a cottage.
- **Unlinked, suspended or paused human avatar:** restore the existing authorized identity/session before requesting construction. Browser-supplied UUIDs/account IDs are refused.

Claim creation and native command delivery are separate durable operations. If delivery fails after a claim is saved, the next request recovers that same plot instead of allocating another.

## API

All routes use the existing `/api/v1` prefix and origin checks.

| Method and route | Access | Result |
| --- | --- | --- |
| `GET /veloren/city` | Public, bounded rate | Configured scripted roster, role/workplace directory, saved public works/research and explicit planned-system status |
| `GET /veloren/city/home` | Current human session | That account's own supported choices, claim/construction status, metrics and recovery instructions |
| `POST /veloren/city/home/request` | Current human session | `{plot_id, style}`; validate, reuse/assign a free plot and ask the existing keeper to build |
| `POST /veloren/city/home/action` | Current human session | `{action: "enter"}` or `{action: "leave"}`; target derived only from the current linked account |

AI runtime and bridge credentials cannot use these guest-session home routes. The existing native keeper's scoped route remains the AI courier path for construction; it cannot claim land or change account visiting settings. Its build path now checks pause, supported native layout, saved occupancy and configured ground estimates too.

## What this release proves

Real Chrome exercises the guest page with temporary accounts/databases, keyboard submission, phone layout, private-account isolation and closing/reopening both databases. The browser probe uses **signed fixture acknowledgements**. It is not a real native-client construction demonstration. Run `node scripts/city-browser-smoke.mjs` with the existing `playwright-core` dev dependency and system Chrome; output defaults to `test-results/city/`.

No main database migration, new reward ledger, new resident credential or external asset is introduced. The city illustration is authored CSS and clearly labelled a vision illustration.

## Remaining city work

The design is in `superpowers/specs/2026-10-17-ai-city-design.md`. Freeform AI-authored native homes, office execution of useful artifacts, a connected modern streetscape and persistent resident households/schooling/age/marriage/children remain subsequent releases. The current roster and buildings do not establish those features. Native pantry restocking is still scripted. The legacy browser game's human work flows remain for compatibility; this release adds the guest city flow rather than claiming a completed global role migration.
