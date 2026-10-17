#!/usr/bin/env bash
# install.sh: install the Harr LaunchAgents (user level, no root). DRY-RUN BY DEFAULT: without --apply it only prints
# what it would write and run.
#
#   ops/launchd/install.sh [--apply] [--only world|backup|hygiene] [--run-at-load] [--world-args "--lite --light-stack"]
#                          [--dest DIR] [--ops-dir DIR] [--print]
#
#   --apply         really write the plists into ~/Library/LaunchAgents and load them with launchctl
#   --only NAME     just one agent (default: all three: world, backup, hygiene)
#   --run-at-load   start the world at login (default: off; start it with: launchctl kickstart gui/$UID/com.harr.world)
#   --world-args    flags for `play-next.sh start`, e.g. "--lite --light-stack"
#   --dest DIR      write plists here instead of ~/Library/LaunchAgents (then nothing is loaded; for review and tests)
#   --ops-dir DIR   where the ops scripts live when launchd runs them (default: the folder this script belongs to);
#                   point it at play/ops after you copied ops there, so launchd does not depend on a worktree
#   --print         also print each rendered plist
# The agents: com.harr.world (KeepAlive on failure), com.harr.backup (daily 04:30), com.harr.hygiene (daily 04:50).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
OPS_DIR="$(dirname "$HERE")"
d="$HERE"; ROOT=""; while [ "$d" != / ]; do [ -f "$d/play/play.sh" ] && { ROOT="$d"; break; }; d="$(dirname "$d")"; done
ROOT="${HARR_ROOT:-$ROOT}"
APPLY=0; ONLY="world backup hygiene"; RUN_AT_LOAD=false; WORLD_ARGS=""; DEST="$HOME/Library/LaunchAgents"; PRINT=0; CUSTOM_DEST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift;;
    --only) ONLY="${2:?world|backup|hygiene}"; shift 2;;
    --run-at-load) RUN_AT_LOAD=true; shift;;
    --world-args) WORLD_ARGS="${2:-}"; shift 2;;
    --dest) DEST="${2:?dir}"; CUSTOM_DEST=1; shift 2;;
    --ops-dir) OPS_DIR="${2:?dir}"; shift 2;;
    --print) PRINT=1; shift;;
    -h|--help) sed -n 2,17p "$0"; exit 0;;
    *) echo "unknown option $1" >&2; exit 64;;
  esac
done
[ -n "$ROOT" ] && [ -f "$ROOT/play/play.sh" ] || { echo "cannot find the Harr folder (the one containing play/play.sh). Set HARR_ROOT." >&2; exit 1; }
for n in $ONLY; do case "$n" in world|backup|hygiene) ;; *) echo "unknown agent '$n'" >&2; exit 64;; esac; done
for w in $WORLD_ARGS; do case "$w" in --lite|--light-stack|--no-model|--force|--keep) ;; *) echo "refusing world argument '$w' (allowed: --lite --light-stack --no-model --force --keep)" >&2; exit 64;; esac; done
UIDN="$(id -u)"
[ "$APPLY" = 1 ] || echo "DRY RUN: nothing is written or loaded. Add --apply to do it."
echo "Harr folder: $ROOT"
echo "scripts used by launchd: $OPS_DIR"
[ -x "$OPS_DIR/play-next.sh" ] || echo "NOTE: $OPS_DIR/play-next.sh is not executable or missing; the world agent would fail until it is."
[ "$CUSTOM_DEST" = 1 ] || { [ -d "$DEST" ] || echo "NOTE: $DEST does not exist yet; it would be created."; }

render() { # template-file -> stdout
  local xml="" w
  for w in $WORLD_ARGS; do xml="$xml    <string>$w</string>
"; done
  python3 - "$1" "$OPS_DIR" "$ROOT" "$HOME" "$RUN_AT_LOAD" "$xml" <<'PY'
import sys
t,ops,root,home,ral,args=sys.argv[1:7]
s=open(t).read()
for k,v in (("__OPS_DIR__",ops),("__ROOT__",root),("__HOME__",home),("__RUN_AT_LOAD__","<%s/>"%ral),("__WORLD_ARGS_XML__",args.rstrip("\n"))):
    s=s.replace(k,v)
sys.stdout.write("\n".join(l for l in s.split("\n") if l.strip()!="" or True))
PY
}

for n in $ONLY; do
  label="com.harr.$n"; src="$HERE/$label.plist.template"; out="$DEST/$label.plist"
  [ -f "$src" ] || { echo "missing template $src" >&2; exit 1; }
  tmp="$(mktemp "${TMPDIR:-/tmp}/harr-plist.XXXXXX")"; render "$src" > "$tmp"
  if ! plutil -lint "$tmp" >/dev/null 2>&1; then echo "FAIL: rendered $label is not a valid plist" >&2; plutil -lint "$tmp" >&2; rm -f "$tmp"; exit 1; fi
  echo
  echo "== $label =="
  echo "  would write:  $out"
  [ "$PRINT" = 1 ] && sed 's/^/    | /' "$tmp"
  if [ "$CUSTOM_DEST" = 1 ]; then
    echo "  would load:   (not with --dest; load by hand: launchctl bootstrap gui/$UIDN $out)"
  else
    echo "  would run:    launchctl bootout gui/$UIDN/$label   (if already loaded; errors ignored)"
    echo "  would run:    launchctl bootstrap gui/$UIDN $out"
    [ "$n" = world ] && [ "$RUN_AT_LOAD" = false ] && echo "  then start:   launchctl kickstart gui/$UIDN/$label      (RunAtLoad is off)"
  fi
  if [ "$APPLY" = 1 ]; then
    mkdir -p "$DEST" "$ROOT/play/logs"
    if [ -f "$out" ] && ! cmp -s "$tmp" "$out"; then cp "$out" "$out.bak.$(date +%Y%m%d%H%M%S)"; echo "  (kept the old file as $out.bak.*)"; fi
    cp "$tmp" "$out"; chmod 644 "$out"; echo "  written."
    if [ "$CUSTOM_DEST" = 0 ]; then
      launchctl bootout "gui/$UIDN/$label" 2>/dev/null
      launchctl bootstrap "gui/$UIDN" "$out" && echo "  loaded." || echo "  launchctl bootstrap failed: see 'launchctl print gui/$UIDN/$label'" >&2
    fi
  fi
  rm -f "$tmp"
done
echo
[ "$APPLY" = 1 ] && echo "Done. Check: launchctl print gui/$UIDN/com.harr.world | head -20" || echo "Dry run finished."
