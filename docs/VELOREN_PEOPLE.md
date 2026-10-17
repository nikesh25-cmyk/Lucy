# Veloren people: villagers who work, greet, scale and stay calm

Stream `people` of the Harr work (`wt/WORK_DIVISION.md`). The villagers stop being
names on a schedule and become a working population.

1. **Work is visible (P1).** At a works site a resident holds its calling's peaceful pose (builders
   crouch over the work, scholars and keepers sit to read, hosts step a working dance), faces the site,
   and says one short line per visit — whispered to a nearby human, public chat only when no one is close.
   Builders and makers follow the director's `work` order to the *currently active* project's site; the
   daily phase table remains the fallback.
2. **The village scales (P2).** `veloren-villagers.json` holds 52 residents (60 with the living roster),
   each with a unique first name, one of the six roles, and a coherent routine over real Harr places. The
   bridge is measured honestly, and the running population is an operational choice, not a content limit.
3. **Harr is calm (P3).** A `peaceful` world setting stops rtsim from ever creating pirates, cultists,
   monsters, wyverns or the sites that house them; `peace.rs` stays as the safety net; a test fails if any
   Harr string a player reads carries combat vocabulary.
4. **Residents greet (P4).** A resident greets a nearby human once per calendar day with a short, role-true
   line — a builder at an active site invites the human to join the crew — scripted, labelled, rate-limited
   and never repeated within a session.

Nothing here is a weapon, a fight or a hunt. Every line is scripted; model text is always tagged `[AI]`.

## Bridge (`veloren/nemo-bridge/`)

* `client/src/lib.rs` gains one public method, `send_control_action(ControlAction)`, so a headless resident
  can send the same action a key press would: `Sit`, `Sneak`, `Stand` or `Dance` — never `Wield`.
* `main.rs` holds the pose table (`role_poses`), the work and greeting lines (`work_lines`,
  `role_greetings`, `work_greetings`), and the `work` director mode. A `site-*` landmark is a works site;
  the crew-gated stages name the same `site-*` ids the works board uses, so a builder walks to the stage
  the village is actually raising.
* New characters are created empty-handed, never holding a sword.
* All new lines are `todo-words` placeholders for the `words` stream; `tests` in the binary keep every line
  short and free of violent vocabulary.

## NemoWorld side (engine-owned, merged into this stream)

`src/veloren-ext/npc-logic.js` gives builders and makers a `work` director order to the active stage's
`site-*` landmark (the works board now carries each stage's `site` through `loadWorks`).

## Tests

* `tests/veloren-calm.test.js` — every string in `nemoworld/content/*.json` and the bridge roster is free
  of `kill|fight|attack|slay|weapon|enemy|battle|blood|dungeon|loot|raid|war|steal` (metadata `note`
  fields excepted).
* `tests/veloren-villagers.test.js` — 52 valid, distinct residents whose routines use real Harr places.
* `nemo-bridge/src/main.rs` `#[cfg(test)]` — poses are peaceful and cover every working calling; work and
  greeting lines are short, varied and free of violent vocabulary.

## Honest limits

One resident bridge process measures about **15 MB resident memory and ~9 % of one core** while walking on
this Mac. Sixty such processes would be roughly **0.9 GB and ~5.4 cores**, which fits the memory but leaves
little CPU headroom for the server and the rest of the system. The content is scaled to 60; how many bridges
to *run* at once is a deployment decision recorded in `evidence/people/NOTES.md`, together with the design
for a multi-resident bridge (one process, several client threads) if the owner wants the whole village live
at once.
