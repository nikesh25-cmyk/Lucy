# NemoWorld public-launch track

The selected release path is a **fresh public world** on the repository's Render Blueprint, with an
**independent AI worker** that connects to it using a short-lived, scoped runtime credential. The Mac
world and its account database stay private; no local database, token, password, model weight or
backup is copied into the hosted world. The first public administrator is created through the hosted
setup flow with its own private `LUCY_SETUP_CODE`.

## Separate AI worker for the first pilot

The Render web service is the authoritative world and holds the only public SQLite database. It
does not install a model or run an AI resident process. A trusted operator creates an AI character,
then uses **Characters → Connect an independent AI agent** to issue a credential for that character
with only `read`, `move` and `chat` at first. The operator adds `contribute` or `build` only for a
specific supervised task. Each credential expires within 20 minutes and has an API-call budget; the
server can revoke it immediately. It cannot review its own evidence, moderate, award coins, enroll
accounts or acquire land. The operator starts the existing `npm run agent` process on a separate
machine with a locally installed Ollama or llama.cpp model, using the hosted HTTPS `WORLD_URL`, the
one-time `WORLD_AGENT_TOKEN` and the model settings in that machine's private environment. The
model endpoint remains loopback **on the worker machine**; it is never opened on the public web
service. See [bounded AI residents](RUNTIME.md) for exact limits and stop behavior.

This is an **operator-run pilot**, not an always-on managed AI fleet. The token is never put in a
Blueprint, repository, browser URL or log. A worker restart needs an operator to issue a fresh
credential after checking the previous run's last saved action. If the worker or model is offline,
the world remains playable and ordinary country conversations use their labelled rules fallback.
Before inviting outsiders, prove the worker can connect over the real HTTPS origin, speak once,
be revoked, and fail to act after revocation; record the observed model host, model name, latency
and operator, without recording the credential or conversation contents in deployment logs.

## Current release boundary

The shipped game supports authenticated humans and scoped AI residents, shared saved world state,
finite buildable land, direct conversation, independent contribution review, bounded virtual coins,
moderation and appeals. The optional Luanti client projects the same server state. It is a local,
tile-based multiplayer world, not a distributed MMO. A Render service with one SQLite disk cannot
become a World of Warcraft-scale service by increasing the instance count: Render does not scale
services with an attached persistent disk to multiple instances ([disk limitations](https://render.com/docs/disks),
[scaling](https://render.com/docs/scaling)).

The code now has a separate encrypted backup CLI and a measured safety/pause drill. Neither code
feature provisions a host, transfers an archive off-host, staffs moderation or approves mission
content. The three research exemplars remain inactive drafts until a human reviews sources, rights,
beneficiary consent and practical scope.

## Release sequence and evidence

| Stage | Owner action and proof | Release decision |
| --- | --- | --- |
| 1. Reviewed source | Run `docs/RELEASE_CHECKLIST.md` G1–G8 on the exact commit; record the SHA and full pass/fail counts. Verify the content seal and asset notices. | Stop on any failed gate. |
| 2. Service selection | In Render, review the Blueprint's `1c-2g` paid web instance, 1 GB persistent disk, region, current price and billing account. Keep `autoDeployTrigger: off`. Render requires a paid service for a persistent disk ([docs](https://render.com/docs/disks)). | Explicit approval before creating a billable public service. |
| 3. Fresh private smoke | Create a **new** disk; confirm schema 23, zero accounts and `registration.mode: "closed"` from `LUCY_INITIAL_REGISTRATION`. Create the administrator using only the generated hosted setup code. Invite two independent human operators for reviewer and moderator roles. Verify G9 and G11 at the real HTTPS origin. | Keep enrollment invitation-only. |
| 4. Recovery | Generate a 32-byte backup key outside the repository and store it separately. Stop the hosted server for a CLI `backup-encrypted`, verify the `.nemoenc` copy, transfer only that copy to independent storage, and restore it to a disposable second installation. Record backup age, retention and a named operator who checks it. | Do not broaden enrollment without a recurring off-host backup and a completed restore drill. |
| 5. Safety and privacy | Exercise a real report, independent moderation, a different appeal reviewer, account suspension, runtime revocation and platform pause at the hosted origin. Assign an incident contact and publish reviewed privacy/terms and community rules before inviting outsiders. | Do not accept unstaffed reports. |
| 6. Invited pilot | Invite a small, named group. Start the independent worker with a fresh scoped credential. Have two humans and that AI resident complete the saved first-play and build flow in real browsers and, if offered, the native Luanti client. Revoke the credential and verify its next action fails. Measure latency, errors, storage growth, moderation load and recovery point on the chosen paid instance. | Expand only from observed capacity and user feedback. |
| 7. Public beta | Add provider edge abuse controls, monitoring/alerting and a tested incident response. Re-run G1–G13 on the exact public build; verify backups, safety staffing, worker revocation and source/asset permissions. | Open signup only after the owner signs the go/no-go record. |

Render provides a public `onrender.com` address, HTTPS termination and custom domains for web
services ([web-service docs](https://render.com/docs/web-services)). A custom domain is optional for
the pilot; when added, configure the exact HTTPS `LUCY_PUBLIC_ORIGIN` and verify host/origin checks.
The Blueprint itself does not create a service merely by being in Git. A separate operator-run AI
worker is required for live resident inference; the web service does not call a remote model provider.
The selected plan is only a pilot starting point: the Mac's M5 capacity numbers do not predict
its 1-CPU hosted throughput.

## Product path beyond a safe public beta

The broader NemoWorld vision needs several independent releases after an invited pilot:

1. **Game feel:** longer contiguous exploration, reliable traversal and portals, character control
   on keyboard/gamepad/touch, authored places, animation, sound, readable quests and accessibility
   tested with actual players. First-play and two-gate browser scenarios prove a path works, not that
   the world feels vast or polished.
2. **Social world:** resilient text conversation and presence at real load, discovery and invitations,
   anti-harassment tools, consent for agent encounters, moderator coverage and appealing decisions.
3. **Purposeful AI labor:** human-approved beneficiaries and mission briefs, licensed evidence,
   measurable outcomes, independent reviewers and an audit trail. No template output or AI self-review
   becomes a real-world impact claim or a coin award by itself.
4. **Economy and land:** keep virtual coins separate from money, compute credits and carbon credits.
   Any sale of land or cash conversion needs a separate legal, tax, consumer and abuse review before
   implementation. Current finite plots are stewardship records, not property rights.
5. **Scale architecture:** move beyond one process and one SQLite writer only after measured demand;
   design shared authoritative state, partitioning, event delivery and failure recovery, then run load,
   soak and security reviews on that new topology. A renderer or Luanti server alone does not provide
   this migration.

## Go/no-go record

Before any public invitation, record: reviewed commit, Render service ID and origin, selected paid
plan and disk cost, administrator identity (not credentials), independent moderator/reviewer names,
AI worker host and operator (not credentials),
last encrypted off-host backup and restore time, exact gate totals, privacy and asset-rights approvals,
incident contact, observed pilot load and the owner who approves opening enrollment. Leave any
missing field marked **not ready**; do not infer approval from a green local test suite.
