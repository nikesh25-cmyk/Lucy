#!/usr/bin/env bash
# harr-backup.sh: what the daily backup agent runs. Refuses when the disk is nearly full (a backup must not be what fills it).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; OPS="$(dirname "$HERE")"
d="$HERE"; while [ "$d" != / ]; do [ -f "$d/play/backup.sh" ] && break; d="$(dirname "$d")"; done
ROOT="${HARR_ROOT:-$d}"; P="$ROOT/play"
free_gb=$(python3 -c "import shutil;print(int(shutil.disk_usage('$P').free/1e9))" 2>/dev/null || echo 0)
min="${HARR_BACKUP_MIN_FREE_GB:-5}"
if [ "$free_gb" -lt "$min" ]; then echo "$(date '+%F %T') backup skipped: only ${free_gb} GB free (need $min)"; exit 1; fi
echo "$(date '+%F %T') backup start (${free_gb} GB free)"
"$P/backup.sh" make || { echo "$(date '+%F %T') backup FAILED"; exit 1; }
umask 077; chmod 700 "$P/backups" 2>/dev/null; chmod 600 "$P"/backups/*.tgz 2>/dev/null
echo "$(date '+%F %T') backup done"
