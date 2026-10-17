#!/usr/bin/env bash
# uninstall.sh: unload and remove the Harr LaunchAgents. DRY-RUN BY DEFAULT: without --apply it only prints what it would do.
#
#   ops/launchd/uninstall.sh [--apply] [--only world|backup|hygiene] [--dest DIR]
#
# Only ever touches files named com.harr.<world|backup|hygiene>.plist. Stopping com.harr.world makes harr-run.sh stop the
# world cleanly (launchd sends it SIGTERM). Logs, backups and the world itself are never touched.
set -u
APPLY=0; ONLY="world backup hygiene"; DEST="$HOME/Library/LaunchAgents"; CUSTOM_DEST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift;;
    --only) ONLY="${2:?world|backup|hygiene}"; shift 2;;
    --dest) DEST="${2:?dir}"; CUSTOM_DEST=1; shift 2;;
    -h|--help) sed -n 2,8p "$0"; exit 0;;
    *) echo "unknown option $1" >&2; exit 64;;
  esac
done
for n in $ONLY; do case "$n" in world|backup|hygiene) ;; *) echo "unknown agent '$n'" >&2; exit 64;; esac; done
UIDN="$(id -u)"
[ "$APPLY" = 1 ] || echo "DRY RUN: nothing is unloaded or removed. Add --apply to do it."
for n in $ONLY; do
  label="com.harr.$n"; f="$DEST/$label.plist"
  echo "== $label =="
  [ "$CUSTOM_DEST" = 1 ] || echo "  would run:    launchctl bootout gui/$UIDN/$label"
  if [ -f "$f" ]; then echo "  would remove: $f"; else echo "  (no $f; nothing to remove)"; fi
  if [ "$APPLY" = 1 ]; then
    [ "$CUSTOM_DEST" = 1 ] || launchctl bootout "gui/$UIDN/$label" 2>/dev/null
    [ -f "$f" ] && rm -f "$f" && echo "  removed."
  fi
done
[ "$APPLY" = 1 ] && echo "Done." || echo "Dry run finished."
