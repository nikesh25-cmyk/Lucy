#!/usr/bin/env bash
# harr-run.sh: the foreground supervisor that launchd runs (see com.harr.world.plist.template).
#   harr-run.sh [play-next.sh start flags...]      e.g. --lite --light-stack
# Starts the world, then checks it every HARR_CHECK_EVERY seconds (default 30). If the world is "down" (NemoWorld or
# the game server gone) HARR_STRIKES checks in a row (default 3), it stops what is left and exits 1: launchd restarts it.
# On SIGTERM/SIGINT (launchctl bootout) it stops the world and exits 0.
# HARR_SUPERVISOR_DRY=1 prints the plan and exits (used for tests).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; OPS="$(dirname "$HERE")"
NEXT="${HARR_NEXT:-$OPS/play-next.sh}"
EVERY="${HARR_CHECK_EVERY:-30}"; STRIKES="${HARR_STRIKES:-3}"
log() { printf '%s harr-run: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
if [ "${HARR_SUPERVISOR_DRY:-0}" = 1 ]; then
  log "would run: $NEXT start $*"; log "then every ${EVERY}s: $NEXT status --json; exit 1 after $STRIKES 'down' checks in a row; stop and exit 0 on SIGTERM"; exit 0
fi
stopping=0
on_term() { stopping=1; log "stop requested"; "$NEXT" stop; exit 0; }
trap on_term TERM INT
log "starting: play-next.sh start $*"
"$NEXT" start "$@" || { log "start failed"; exit 1; }
bad=0
while :; do
  sleep "$EVERY" & wait $!
  state="$("$NEXT" status --json 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['overall'])" 2>/dev/null || echo unknown)"
  case "$state" in
    ok|degraded) bad=0;;
    *) bad=$((bad+1)); log "world is '$state' ($bad of $STRIKES)"
       if [ "$bad" -ge "$STRIKES" ]; then log "giving up on this run; launchd will start it again"; "$NEXT" stop; exit 1; fi;;
  esac
done
