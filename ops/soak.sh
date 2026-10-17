#!/usr/bin/env bash
# soak.sh: sample load, memory and process counts of a running Harr into a CSV, for N minutes.
#
#   ops/soak.sh [MINUTES] [--every SECONDS] [--out FILE]
#
# Defaults: 30 minutes, one row every 30 s, ops/soak-YYYYmmdd-HHMMSS.csv (play/logs/ when the play folder exists).
# Read-only and light (one ps and a few quick reads per row). Columns:
#   time, elapsed_s, load1, load5, mem_available_mb, swap_used_mb, disk_free_gb,
#   server_procs, bridge_procs, node_procs, cargo_procs, server_rss_mb, bridge_rss_mb, node_rss_mb, harr_health_ok, new_errors
# server/bridge/node counts are machine-wide (every veloren-server-cli, nemo-bridge and NemoWorld node process), so other
# test stacks on the same Mac show up too: that is deliberate, they compete for the same CPU.
# At the end it prints min / mean / max of load and memory so the run can be compared with the next one.
# Environment: HARR_ROOT. For tests: SOAK_DRY=1 prints the plan only, SOAK_SECONDS=N counts seconds instead of minutes.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${HARR_ROOT:-$(cd "$HERE/.." && pwd)}"; P="$ROOT/play"
LIB="$HERE/lib/harr_ops.py"; [ -f "$LIB" ] || LIB="$P/lib/harr_ops.py"
export HARR_ROOT="$ROOT"
MIN=30; EVERY=30; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --every) EVERY="${2:?seconds}"; shift 2;;
    --out) OUT="${2:?file}"; shift 2;;
    -h|--help) sed -n 2,14p "$0"; exit 0;;
    *[!0-9]*) echo "unknown option $1" >&2; exit 64;;
    *) MIN="$1"; shift;;
  esac
done
[ "$EVERY" -ge 1 ] 2>/dev/null || { echo "--every must be a whole number of seconds" >&2; exit 64; }
if [ -z "$OUT" ]; then d="$HERE"; [ -d "$P/logs" ] && d="$P/logs"; OUT="$d/soak-$(date +%Y%m%d-%H%M%S).csv"; fi
TOTAL=$((MIN*60)); [ -n "${SOAK_SECONDS:-}" ] && TOTAL="$SOAK_SECONDS"
ROWS=$(( TOTAL / EVERY + 1 ))
echo "soak: $ROWS samples, one every ${EVERY}s over ${TOTAL}s -> $OUT"
[ "${SOAK_DRY:-0}" = 1 ] && { python3 "$LIB" sample --header; echo "(dry run: nothing sampled)"; exit 0; }
python3 "$LIB" sample --header > "$OUT" || exit 1
export HARR_SOAK_START="$(date +%s)"
python3 "$LIB" watch-line >/dev/null 2>&1      # record log positions so old errors are not counted
trap 'echo; echo "interrupted; summarising what was sampled"; summarise; exit 0' INT TERM
summarise() {
  python3 - "$OUT" <<'PY'
import csv,sys
rows=list(csv.DictReader(open(sys.argv[1])))
if not rows: print("no samples"); sys.exit()
def col(n):
    v=[float(r[n]) for r in rows if r[n] not in ("","None")]
    return (min(v),sum(v)/len(v),max(v)) if v else None
print("samples: %d over %s s"%(len(rows),rows[-1]["elapsed_s"]))
for n,label in (("load1","load (1 min)"),("mem_available_mb","memory available MB"),("swap_used_mb","swap used MB"),("server_rss_mb","server rss MB"),("bridge_rss_mb","bridge rss MB"),("node_rss_mb","node rss MB"),("server_procs","server procs"),("bridge_procs","bridge procs"),("node_procs","node procs"),("cargo_procs","cargo/rustc procs")):
    c=col(n)
    if c: print("  %-22s min %8.1f  mean %8.1f  max %8.1f"%((label,)+c))
print("  new error lines: %d   samples with health failing: %d"%(sum(int(r["new_errors"] or 0) for r in rows),sum(r["harr_health_ok"]=="0" for r in rows)))
PY
}
i=0
while [ "$i" -lt "$ROWS" ]; do
  python3 "$LIB" sample >> "$OUT"
  i=$((i+1)); [ "$i" -lt "$ROWS" ] && sleep "$EVERY"
done
summarise
