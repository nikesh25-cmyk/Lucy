# Hosting Harr for real players

Today Harr runs only on the owner's Mac, on `127.0.0.1`. This is what must change before anyone else joins, and what the owner has to decide. Nothing here has been done; it is a checklist and a design.

## What already exists

* **Invitations and registration control in NemoWorld.** The first account is the administrator (on a public origin a private `LUCY_SETUP_CODE` of 24+ characters is required). An administrator creates single-use invitations (`POST /api/v1/invites`) and sets registration to open or closed (`/api/v1/operations/registration`). A closed server accepts only invited registrations. Rate limiting for sign-in and registration is stricter in public mode (`src/hosting.js`).
* **Scoped, expiring, revocable link credentials** (bridge, relays, guide) and signed events and commands. They never leave the machine that runs NemoWorld and the game server.
* **Backups:** `play/backup.sh make|list|restore`; health: `play/health.sh`.

## What must change

1. **Never expose the game server as it is.** `play.sh` starts Veloren with `--no-auth`: anyone who can reach it can log in as any name, including as a resident's name or as an administrator's. For real players run Veloren **with** authentication (remove `--no-auth`), so each player proves an account on Veloren's auth server; the link (`player_uuid`) then really identifies a person. The residents are bots and need an account setup too (or a server setting that lets them join: decide with the owner; the alternative is a private bot-only listener on loopback and a public one with auth, which Veloren does not offer today).
2. **Admin rights.** Only the owner's account holds admin (`admins.ron` by account uuid), never a name; `/admin` and `/tp` are not given to players.
3. **Network.** Game port 14004 (TCP) and, if wanted, the status port 14006 are the only things to open. Keep 14005 (web), NemoWorld 3100 and the model on loopback. Put NemoWorld behind a TLS reverse proxy (Caddy or nginx) on a name you own, set `LUCY_PUBLIC_ORIGIN`, and keep `/api/v1/veloren/*` reachable only from the machine (the bridge and relays run beside it). The dashboard at `/harr` is aggregate and safe to expose; the guide and link routes need credentials and must not be.
4. **Capacity.** On the owner's Mac the 32 residents plus a game client already keep the load average around 6 to 12. Real players add load: measure with `play/health.sh` while a few friends join, and cap `max_players` in `settings.ron`. A small always-on machine or a rented server is likely better than a laptop that sleeps.
5. **Always-on.** The world only progresses (works clock, events, pantry) while the server runs. A laptop that sleeps pauses Harr; that is by design, but a hosted world should run as a service (launchd or systemd) with automatic restart and a daily `play/backup.sh make`.
6. **Moderation.** Report and mute tools do not exist yet. The world has no combat, no trading and no free chat with strangers beyond Veloren's own chat; the owner decides on chat moderation (word filter, `/mute`, a human moderator) before inviting strangers.
7. **Privacy and consent.** NemoWorld requires adult consent at registration. A privacy notice for what is stored (aliases of finders, pantry takes, positions at events) must be written before inviting the public.

## Decisions for the owner

* Public or invite-only? (Recommended: invite-only for the first weeks.)
* Where to host (a spare machine at home, a rented server) and who is the moderator.
* Whether residents may keep joining without accounts on a private listener, or get accounts.
* Whether to use the DeepSeek API for residents (cost, privacy notice, key kept in a file, never in chat).
* A backup destination outside the machine.

Operating the world day to day (start, stop, backup, resource budget, failures, upgrades): see [HARR_OPERATIONS.md](HARR_OPERATIONS.md).
