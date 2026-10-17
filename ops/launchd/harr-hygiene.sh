#!/usr/bin/env bash
# harr-hygiene.sh: what the daily hygiene agent runs: fix permissions, rotate logs, then check for leaked tokens.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; OPS="$(dirname "$HERE")"
echo "$(date '+%F %T') hygiene start"
"$OPS/hygiene.sh" fix --apply
"$OPS/hygiene.sh" rotate --apply
"$OPS/hygiene.sh" check; rc=$?
echo "$(date '+%F %T') hygiene done (check exit $rc)"
exit $rc
