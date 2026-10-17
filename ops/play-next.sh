#!/usr/bin/env bash
# play-next.sh: a proposal for the next play.sh. Same world, same files, same pid and log names, so it can run
# next to the old launcher (stop with either). Review it, then copy the ops folder into play/:
#   cp -R ops play/ops        (the scripts find the Harr folder by looking upward for play/play.sh)
#
#   play-next.sh preflight [flags]     check the Mac (disk, memory, swap, load, compilers, ports); changes nothing
#   play-next.sh start [flags]         pre-flight, then a staged start with a readiness check per stage and a summary
#   play-next.sh status [--json]       what is running; --json for scripts
#   play-next.sh watch [--once]        every 30 s: load, memory, processes, works progress, new errors (Ctrl-C to leave)
#   play-next.sh stop                  stop everything this launcher (or play.sh) started
#   play-next.sh setup|client|admin|logs|reset-world ...   handed to play.sh unchanged
#
# Start flags:
#   --lite          no local AI model (scripted replies) and only 12 villagers (VILLAGE=12). For an overloaded Mac.
#   --light-stack   low memory: halves the bridge tick rate, quiets bridge logging, caps Node heaps. Combine with --lite.
#   --no-model      like play.sh: no local AI model, all villagers
#   --dry-run       print exactly what would run (secrets are never printed) and start nothing
#   --force         start even if pre-flight says "refuse" (you accept a slow or failed start)
#   --keep          if a stage fails, leave what is running instead of stopping it
# Environment: VILLAGE=N starts the first N villagers (0 = none, unset = all). NEMO_NODE, NEMO_PORT as in play.sh.
#   HARR_ROOT overrides the folder that contains play/ (used for tests).
# Exit codes: 0 ok, 1 a stage failed, 2 refused by pre-flight, 64 bad usage.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
find_root() { # the folder that contains play/play.sh: this script's own parents, whether it lives in ops/ or in play/ops/ or play/
  local d="$1"
  while [ "$d" != / ]; do
    [ -f "$d/play/play.sh" ] && { echo "$d"; return; }
    [ -f "$d/play.sh" ] && [ -d "$d/bin" ] && { dirname "$d"; return; }
    d="$(dirname "$d")"
  done
}
ROOT="${HARR_ROOT:-$(find_root "$HERE")}"
P="$ROOT/play"
LIB="$HERE/lib/harr_ops.py"; [ -f "$LIB" ] || LIB="$P/lib/harr_ops.py"
export HARR_ROOT="$ROOT"
SRC_V="$ROOT/wt/veloren-integ"
NODE="${NEMO_NODE:-$ROOT/../Lucy/.runtime/node-v24.19.0-darwin-arm64/node}"
NEMO_PORT="${NEMO_PORT:-3100}"; VEL=14004
NEMO="http://127.0.0.1:$NEMO_PORT"; export NEMO_PORT
ALL="lw-aria lw-theron lw-bram lw-lyra lw-kael lw-selene lw-vaelen lw-rowan"
ROLE_FLAG() { case "$1" in lw-selene) echo "--guide";; lw-kael) echo "--shop";; lw-rowan) echo "--home";; lw-vaelen) echo "--atlas";; *) echo "";; esac; }

# knobs (all overridable from the environment)
T_NEMO="${HARR_T_NEMO:-240}"; T_SERVER="${HARR_T_SERVER:-420}"; T_LANDMARKS="${HARR_T_LANDMARKS:-60}"
CALM_PER_CPU="${HARR_CALM_PER_CPU:-0.9}"; CALM_MAX="${HARR_CALM_MAX:-180}"; BATCH="${HARR_BATCH:-4}"
WATCH_EVERY="${HARR_WATCH_EVERY:-30}"

DRY=0; FORCE=0; KEEP=0; LITE=0; LIGHT=0; NOMODEL=0; WARNINGS=""
py() { python3 "$LIB" "$@"; }
say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
is_up() { [ "$DRY" = 1 ] || alive "$1"; }       # in a dry run everything "starts"
stop_pid() { if alive "$1"; then kill "$(cat "$1")" 2>/dev/null; for _ in 1 2 3 4 5 6 7 8 9 10; do alive "$1" || break; sleep 1; done; alive "$1" && kill -9 "$(cat "$1")" 2>/dev/null; fi; rm -f "$1"; }
sleepq() { [ "$DRY" = 1 ] || sleep "$1"; }
warn() { WARNINGS="$WARNINGS|$1"; }

villagers() { # the first N villager ids (VILLAGE=0: none; unset: all)
  [ "${VILLAGE:-all}" = 0 ] && return 0
  python3 - "$P/nemoworld/content/veloren-villagers.json" "${VILLAGE:-all}" <<'PY' 2>/dev/null
import json,sys
ids=[r['id'] for r in json.load(open(sys.argv[1]))['residents']]
n=sys.argv[2]
print(' '.join(ids if n=='all' else ids[:int(n)]))
PY
}

# spawn NAME PIDFILE LOGFILE CWD [VAR=value | VAR=@secretfile]... -- COMMAND...
# A value written @file is read from that file when the program starts and is never printed, not even in --dry-run.
spawn() {
  local name="$1" pidf="$2" logf="$3" cwd="$4"; shift 4
  local envs=() v k val
  while [ "$1" != "--" ]; do
    v="$1"; k="${v%%=*}"; val="${v#*=}"
    if [ "${val#@}" != "$val" ]; then
      if [ "$DRY" = 1 ]; then envs+=("$k=<secret from ${val#@}>"); else envs+=("$k=$(cat "${val#@}")"); fi
    else envs+=("$v"); fi
    shift
  done
  shift
  if [ "$DRY" = 1 ]; then local line="  [dry-run] $name: cd ${cwd#"$ROOT"/} && ${envs[*]} $* >> ${logf#"$ROOT"/}"; say "${line//"$ROOT"/\$ROOT}"; return 0; fi
  # Logs are opened in append mode (>>) so hygiene.sh can rotate a running world's logs safely (copy and truncate).
  # The previous run's log is kept as NAME.log.prev, so readiness checks never see an old "ready to accept".
  [ -s "$logf" ] && mv -f "$logf" "$logf.prev"
  ( cd "$cwd" && exec nohup env "${envs[@]}" "$@" < /dev/null >> "$logf" 2>&1 ) & echo $! > "$pidf"; disown
}

load1() { python3 -c "import os;print('%.1f'%os.getloadavg()[0])"; }
cpus() { python3 -c "import os;print(os.cpu_count() or 1)"; }
calm_wait() { # let the load settle before adding more processes (never forever)
  [ "$DRY" = 1 ] && return 0
  local waited=0 limit; limit=$(python3 -c "print(round($CALM_PER_CPU*$(cpus),1))")
  while python3 -c "import os,sys;sys.exit(0 if os.getloadavg()[0] > $limit else 1)"; do
    [ "$waited" -ge "$CALM_MAX" ] && { say "  load is still $(load1) after ${CALM_MAX}s; carrying on"; warn "load stayed high ($(load1)) during start"; return 0; }
    [ "$waited" = 0 ] && say "  waiting for the load to settle (now $(load1), want under $limit)..."
    sleep 5; waited=$((waited+5))
  done
}

wait_until() { # SECONDS DESCRIPTION command...   -> 0 when the command succeeds in time
  local secs="$1" what="$2"; shift 2
  [ "$DRY" = 1 ] && { say "  [dry-run] would wait up to ${secs}s for: $what"; return 0; }
  local i=0
  while [ "$i" -lt "$secs" ]; do "$@" && return 0; sleep 1; i=$((i+1)); done
  return 1
}
nemo_up() { curl -s -m2 -o /dev/null "$NEMO/api/v1/health"; }
server_ready() { grep -q "ready to accept" "$P/logs/server.log" 2>/dev/null; }

do_stop() {
  for f in "$P"/pids/res-* "$P"/pids/relay-*; do [ -e "$f" ] && stop_pid "$f"; done
  stop_pid "$P/pids/veloren"; stop_pid "$P/pids/nemo"; rm -f "$P/pids/mode.json" "$P/pids/.append-logs"; sleep 1; say "stopped"
}

fail_stage() { # message, log
  say "" >&2; say "STOPPED AT: $1" >&2
  if [ -n "${2:-}" ]; then say "Last lines of ${2#"$ROOT"/}:" >&2; tail -8 "$2" 2>/dev/null | sed -E 's/\x1b\[[0-9;]*m//g' | cut -c1-200 | sed 's/^/    /' >&2; fi
  if [ "$KEEP" = 1 ]; then say "Leaving everything as it is (--keep). Stop with: play-next.sh stop" >&2
  else say "Stopping what was started so the Mac is left clean (use --keep to leave it)." >&2; do_stop >/dev/null; fi
  exit 1
}

cmd_start() {
  [ -x "$P/bin/veloren-server-cli" ] || die "The programs are not set up. Run: play/play.sh setup" 64
  local pf=(); if [ "$NOMODEL" = 1 ]; then pf+=(--no-model); else pf+=(--model); fi; [ "$LIGHT" = 1 ] && pf+=(--light)
  say "== 1/6 pre-flight checks =="
  py preflight "${pf[@]}"; local rc=$?
  if [ "$rc" = 2 ]; then
    if [ "$FORCE" = 1 ]; then say "Pre-flight says refuse, but --force was given. Going on; expect a slow start."; warn "started despite a failed pre-flight"
    else say ""; die "Not starting: the Mac cannot take Harr right now (see the FAIL lines). Fix them, try --lite / --light-stack, or use --force." 2; fi
  elif [ "$rc" = 3 ]; then warn "pre-flight warnings (see above)"; say "Warnings above: starting anyway, with pauses between stages."; fi
  [ "$DRY" = 1 ] && say "(dry-run: nothing below is executed)"
  [ "$DRY" = 1 ] || do_stop >/dev/null 2>&1
  local TPS=12 RUSTLOG="warn,nemo_bridge=info" NODEOPT_RELAY="" NODEOPT_NEMO="" label model
  model=on; [ "$NOMODEL" = 1 ] && model=off
  [ "$LIGHT" = 1 ] && { TPS=6; RUSTLOG="error"; NODEOPT_RELAY="--max-old-space-size=160"; NODEOPT_NEMO="--max-old-space-size=768"; }
  local V nv; V="$(villagers)"; nv=$(echo "$V" | wc -w | tr -d ' ')
  label="model $model, $nv villagers"; [ "$LIGHT" = 1 ] && label="$label, light stack"
  say "mode: $label"
  [ "$DRY" = 1 ] || printf '{"label": "%s", "model": "%s", "village": "%s", "light": %s, "started": %s}\n' "$label" "$model" "${VILLAGE:-all}" "$([ "$LIGHT" = 1 ] && echo true || echo false)" "$(date +%s)" > "$P/pids/mode.json"
  local t0 id
  [ "$DRY" = 1 ] || : > "$P/pids/.append-logs"

  say ""; say "== 2/6 NemoWorld =="
  t0=$(date +%s)
  spawn nemo "$P/pids/nemo" "$P/logs/nemo.log" "$ROOT" NEMO_NO_MODEL="$([ "$NOMODEL" = 1 ] && echo 1 || echo 0)" NEMO_WORLD_RECORD="$P/data/veloren-outbox.jsonl.world.json" NEMO_ROOT="$P/nemoworld" NEMO_PORT="$NEMO_PORT" NEMO_DEV_DIR="$P" NEMO_AI_ROOT="$ROOT/../Lucy" ${NODEOPT_NEMO:+NODE_OPTIONS=$NODEOPT_NEMO} -- "$NODE" dev/start-nemo.mjs
  wait_until "$T_NEMO" "NemoWorld answers $NEMO/api/v1/health" nemo_up || fail_stage "NemoWorld did not answer within ${T_NEMO}s." "$P/logs/nemo.log"
  say "  NemoWorld is answering ($(( $(date +%s) - t0 )) s)"

  say ""; say "== 3/6 Veloren game server (world generation takes about a minute) =="
  calm_wait; t0=$(date +%s)
  spawn veloren "$P/pids/veloren" "$P/logs/server.log" "$SRC_V" VELOREN_USERDATA="$P/userdata" NEMO_LINK_CONFIG="$P/veloren-link.json" NEMO_LINK_EVENT_KEY=@"$P/secrets/event.key" -- "$P/bin/veloren-server-cli" --non-interactive --no-auth
  wait_until "$T_SERVER" "the server log says 'ready to accept'" server_ready || fail_stage "The game server was not ready within ${T_SERVER}s. (If the Mac is swapping, try --lite; if the log shows a panic, see docs/OPERATIONS.md.)" "$P/logs/server.log"
  grep -q panicked "$P/logs/server.log" 2>/dev/null && warn "the server log already contains a panic"
  say "  server ready ($(( $(date +%s) - t0 )) s)"
  local LM="$P/data/veloren-outbox.jsonl.landmarks.json"
  wait_until "$T_LANDMARKS" "landmarks file appears" test -f "$LM" || { say "  landmarks file not written yet; residents will still start"; warn "landmarks file missing"; }

  say ""; say "== 4/6 relays (8) =="
  for id in $ALL; do
    spawn "relay $id" "$P/pids/relay-$id" "$P/logs/relay-$id.log" "$P/nemoworld" NEMO_LINK_TOKEN=@"$P/secrets/events-$id.token" ${NODEOPT_RELAY:+NODE_OPTIONS=$NODEOPT_RELAY} -- "$NODE" scripts/veloren-relay.mjs --outbox "$P/data/veloren-outbox.jsonl" --url "$NEMO" --resident "$id"
  done
  sleepq 3
  local bad=0; for id in $ALL; do is_up "$P/pids/relay-$id" || { say "  relay $id exited"; bad=$((bad+1)); }; done
  [ "$bad" -gt 0 ] && warn "$bad relay(s) exited right after start"
  say "  relays: $((8-bad)) of 8 up"

  say ""; say "== 5/6 residents: 8 core, then $nv villagers in batches of $BATCH =="
  local started=0 up=0 vup=0
  for id in $ALL; do
    spawn "resident $id" "$P/pids/res-$id" "$P/logs/resident-$id.log" "$SRC_V" VELOREN_USERDATA="$P/userdata" RUST_LOG="$RUSTLOG" NEMO_LINK_TOKEN=@"$P/secrets/bridge-$id.token" -- "$P/bin/nemo-bridge" --server "localhost:$VEL" --resident "$id" $(ROLE_FLAG "$id") --roster "$P/data/roster-all.json" --tps "$TPS" --landmarks "$LM" --nemo-url "$NEMO"
    sleepq 3
  done
  for id in $ALL; do is_up "$P/pids/res-$id" && up=$((up+1)); done
  say "  core residents: $up of 8 up"
  [ "$up" -ge 6 ] || fail_stage "Only $up of 8 core residents are running." "$P/logs/resident-lw-lyra.log"
  [ "$up" -lt 8 ] && warn "$((8-up)) core resident(s) down"
  for id in $V; do
    if [ "$started" -gt 0 ] && [ $((started % BATCH)) = 0 ]; then say "  ...$started villagers started, pausing for the load"; calm_wait; fi
    spawn "villager $id" "$P/pids/res-$id" "$P/logs/resident-$id.log" "$SRC_V" VELOREN_USERDATA="$P/userdata" RUST_LOG="$RUSTLOG" NEMO_LINK_TOKEN=@"$P/secrets/bridge-$id.token" -- "$P/bin/nemo-bridge" --server "localhost:$VEL" --resident "$id" --roster "$P/data/roster-all.json" --tps "$TPS" --landmarks "$LM" --nemo-url "$NEMO"
    started=$((started+1)); sleepq 2
  done
  sleepq 3
  for id in $V; do is_up "$P/pids/res-$id" && vup=$((vup+1)); done
  say "  villagers: $vup of $nv up"
  [ "$vup" -lt "$nv" ] && warn "$((nv-vup)) villager(s) down"

  say ""; say "== 6/6 summary =="
  if [ "$DRY" = 1 ]; then say "(dry-run finished: nothing was started)"; return 0; fi
  py status
  if [ -n "$WARNINGS" ]; then say ""; say "Warnings:"; echo "$WARNINGS" | tr '|' '\n' | sed '/^$/d;s/^/  - /'; fi
  say ""
  say "READY. Game: play/play.sh client (Multiplayer, server: localhost).  NemoWorld: $NEMO"
  say "Keep an eye on it: play-next.sh watch      Stop: play-next.sh stop"
}

cmd_watch() {
  local once=0; [ "${1:-}" = "--once" ] && once=1
  [ "$once" = 1 ] || say "Every ${WATCH_EVERY}s: time, state, load/cpus, memory, swap, processes, works, new error lines. Ctrl-C to leave."
  py watch-line >/dev/null 2>&1   # the first look records log positions; history is not news
  while :; do
    py watch-line
    [ "$once" = 1 ] && return 0
    if [ -n "${HARR_WATCH_COUNT:-}" ]; then HARR_WATCH_COUNT=$((HARR_WATCH_COUNT-1)); [ "$HARR_WATCH_COUNT" -le 0 ] && return 0; fi
    sleep "$WATCH_EVERY"
  done
}

SUB="${1:-help}"; [ $# -gt 0 ] && shift
ARGS=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1;; --force) FORCE=1;; --keep) KEEP=1;;
    --lite) LITE=1; NOMODEL=1;; --light-stack) LIGHT=1;; --no-model) NOMODEL=1;;
    *) ARGS+=("$a");;
  esac
done
[ "$LITE" = 1 ] && VILLAGE="${VILLAGE:-12}"
[ -n "${VILLAGE:-}" ] && export VILLAGE

case "$SUB" in
  preflight) pf=(); [ "$NOMODEL" = 1 ] && pf+=(--no-model); [ "$LIGHT" = 1 ] && pf+=(--light); py preflight ${pf[@]+"${pf[@]}"}; exit $?;;
  start) cmd_start;;
  status) py status ${ARGS[@]+"${ARGS[@]}"}; exit $?;;
  watch) cmd_watch ${ARGS[@]+"${ARGS[0]}"};;
  stop) if [ "$DRY" = 1 ]; then say "[dry-run] would stop: residents, relays, Veloren server, NemoWorld (pid files in play/pids)"; else do_stop; fi;;
  setup|client|admin|logs|reset-world) exec "$P/play.sh" "$SUB" "$@";;
  *) sed -n 2,23p "$0"; exit 64;;
esac
