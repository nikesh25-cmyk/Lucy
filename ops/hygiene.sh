#!/usr/bin/env bash
# hygiene.sh: log rotation and secrets hygiene for play/.
#
#   ops/hygiene.sh check                 read-only: secret permissions, backup permissions, tokens in logs or git
#   ops/hygiene.sh fix    [--apply]      set play/secrets to 700 / 600 and play/backups to 700 / 600
#   ops/hygiene.sh rotate [--apply]      rotate play/logs: copy to NAME.log.1.gz and truncate any log over the size limit
#   ops/hygiene.sh all    [--apply]      check, fix, rotate
#
# fix and rotate only PRINT what they would do unless you add --apply. check never changes anything.
#
# Rotation is "copy and truncate", which is safe for a running world only when the program writes in append mode.
# play-next.sh starts every program that way (>>). play.sh (the old launcher) opens logs with a plain > : for those
# the log is only rotated when nothing of Harr is running (otherwise the program keeps writing at its old offset and
# leaves a gap of NUL bytes). Rotate with the world stopped if you still use play.sh.
#
# check looks for the VALUES of every file in play/secrets inside play/logs (plain and .gz) and inside the tracked files of each
# git repo in HARR_GIT_REPOS (default: the nemoworld repo; its worktrees share it; HARR_GIT_REFS picks the branches whose latest commit is searched, default integration/all and the checked-out one), and for token-shaped strings
# (Bearer ..., NEMO_LINK_TOKEN=...). It prints file names only, never the matching text.
#
# Environment: HARR_ROOT, HARR_LOG_MAX_MB (default 20), HARR_LOG_KEEP (default 5 rotated copies), HARR_GIT_REPOS (space separated paths).
# Exit code: 0 clean, 1 something needs attention (a FAIL), 0 with WARN lines is still "clean enough".
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
MAXMB="${HARR_LOG_MAX_MB:-20}"; KEEP="${HARR_LOG_KEEP:-5}"
REPOS="${HARR_GIT_REPOS:-$ROOT/nemoworld $(cd "$HERE/.." && pwd)}"
SHAPE='Bearer [A-Za-z0-9._~+/=-]{20,}|NEMO_LINK_TOKEN=[A-Za-z0-9]{12,}|NEMO_LINK_EVENT_KEY=[A-Fa-f0-9]{16,}'
MODE_OF() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null; }
FAILS=0; WARNS=0
ok()   { printf 'OK    %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; WARNS=$((WARNS+1)); }
bad()  { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS+1)); }
APPLY=0
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
harr_running() { for f in "$P"/pids/*; do case "$f" in *mode.json) continue;; esac; alive "$f" && return 0; done; return 1; }

do_chmod() { # MODE PATH   (prints; applies only with --apply)
  if [ "$APPLY" = 1 ]; then chmod "$1" "$2" && echo "      chmod $1 ${2#"$ROOT"/}"; else echo "      would: chmod $1 ${2#"$ROOT"/}"; fi
}

perms() { # report (and, for fix, repair) permissions
  local mode="$1" f m wrong=0   # mode: check|fix
  flag() { if [ "$mode" = fix ]; then printf 'FIX   %s\n' "$2"; else "$1" "$2"; fi; }      # when fixing, a wrong mode is a task, not a problem
  for d in "$P/secrets" "$P/backups"; do
    [ -d "$d" ] || continue
    m=$(MODE_OF "$d")
    if [ "$m" = 700 ]; then ok "${d#"$ROOT"/} is 700"
    else
      [ "$d" = "$P/secrets" ] && flag bad "${d#"$ROOT"/} is $m, must be 700" || flag warn "${d#"$ROOT"/} is $m, should be 700 (backups hold player data)"
      wrong=1; [ "$mode" = fix ] && do_chmod 700 "$d"
    fi
    local n=0 nbad=0
    for f in "$d"/*; do
      [ -f "$f" ] || continue
      n=$((n+1)); m=$(MODE_OF "$f")
      if [ "$m" != 600 ]; then nbad=$((nbad+1)); [ "$mode" = fix ] && do_chmod 600 "$f"; fi
    done
    if [ "$nbad" = 0 ]; then ok "all $n file(s) in ${d#"$ROOT"/} are 600"
    else
      [ "$d" = "$P/secrets" ] && flag bad "$nbad of $n file(s) in ${d#"$ROOT"/} are not 600" || flag warn "$nbad of $n file(s) in ${d#"$ROOT"/} are not 600"
    fi
  done
}

patterns() { # writes the secret VALUES (one per line, at least 16 characters) to a private temp file, prints its path
  local pat; pat="$(mktemp "${TMPDIR:-/tmp}/harr-hyg.XXXXXX")"; chmod 600 "$pat"
  for f in "$P"/secrets/*; do
    [ -f "$f" ] || continue
    v="$(tr -d '\n\r' < "$f")"
    [ "${#v}" -ge 16 ] && printf '%s\n' "$v" >> "$pat"
  done
  echo "$pat"
}

leaks() {
  [ -d "$P/secrets" ] || { warn "no play/secrets folder: nothing to look for"; return; }
  local pat; pat="$(patterns)"
  if [ ! -s "$pat" ]; then rm -f "$pat"; warn "no secret values of 16+ characters found in play/secrets"; return; fi
  local hits="" f
  if [ -d "$P/logs" ]; then
    hits="$(grep -rlF -f "$pat" "$P/logs" 2>/dev/null | grep -v '\.gz$')"
    for f in "$P"/logs/*.gz; do [ -f "$f" ] && gzip -dc "$f" 2>/dev/null | grep -qF -f "$pat" && hits="$hits
$f"; done
  fi
  hits="$(echo "$hits" | sed '/^$/d')"
  if [ -z "$hits" ]; then ok "no secret value from play/secrets appears in play/logs"
  else bad "a secret value appears in these logs (rotate the credential: play/play.sh setup after deleting the token file; then delete the log):"; echo "$hits" | sed "s#^$ROOT/#      #"; fi
  local shape; shape="$(grep -rlE "$SHAPE" "$P/logs" 2>/dev/null | grep -v '\.gz$' | sed "s#^$ROOT/#      #")"
  [ -z "$shape" ] && ok "no token-shaped strings in play/logs" || { warn "token-shaped strings in these logs (file names only; look at them yourself):"; echo "$shape"; }
  local repo found any=0 seen="" common
  for repo in $REPOS; do
    git -C "$repo" rev-parse -q --git-dir >/dev/null 2>&1 || continue
    common="$(cd "$repo" && cd "$(git rev-parse --git-common-dir)" && pwd)"      # worktrees share one repository: look once
    case " $seen " in *" $common "*) continue;; esac
    seen="$seen $common"
    any=1
    found="$(git -C "$repo" grep -lF -f "$pat" 2>/dev/null)"
    [ -z "$found" ] && ok "no secret value in tracked files of $(basename "$repo")" || { bad "secret value in tracked files of $(basename "$repo"):"; echo "$found" | sed 's/^/      /'; }
    # committed history of the current branches: a secret removed later is still in history
    local refs rhit=""
    refs="${HARR_GIT_REFS:-refs/heads/integration/all $(git -C "$repo" symbolic-ref -q HEAD)}"      # the branch the world runs from, and the checked-out one
    for r in $refs; do
      found="$(git -C "$repo" grep -lF -f "$pat" "$r" 2>/dev/null | head -3)"
      [ -n "$found" ] && rhit="$rhit ${r#refs/heads/}"
    done
    [ -z "$rhit" ] && ok "no secret value in the latest commit of the branches checked ($(echo $refs | sed "s#refs/heads/##g")) in $(basename "$repo")" || bad "secret value committed on branch(es):$rhit in $(basename "$repo")"
    found="$(git -C "$repo" grep -lE "$SHAPE" 2>/dev/null | head -8)"
    if [ -n "$found" ]; then warn "token-shaped strings in tracked files of $(basename "$repo") (may be test fixtures; review):"; echo "$found" | sed 's/^/      /'; fi
  done
  [ "$any" = 1 ] || warn "no git repository found in HARR_GIT_REPOS; git was not checked"
  if git -C "$ROOT" rev-parse -q --git-dir >/dev/null 2>&1; then
    git -C "$ROOT" check-ignore -q play/secrets/event.key && ok "play/secrets is git-ignored" || bad "play/secrets is not git-ignored"
  fi
  rm -f "$pat"
}

rotate() {
  [ -d "$P/logs" ] || { warn "no play/logs"; return; }
  local running=0; harr_running && running=1
  local f size lim=$((MAXMB*1048576)) did=0 append
  for f in "$P"/logs/*.log; do
    [ -f "$f" ] || continue
    size=$(stat -f '%z' "$f" 2>/dev/null || stat -c '%s' "$f")
    [ "$size" -gt "$lim" ] || continue
    did=1
    if [ "$running" = 1 ] && [ ! -f "$P/pids/.append-logs" ]; then
      warn "${f#"$ROOT"/} is $((size/1048576)) MB but Harr is running with plain > logs: stop it first, or start with play-next.sh (it writes logs in append mode and creates play/pids/.append-logs)"
      continue
    fi
    if [ "$APPLY" = 1 ]; then
      local i
      for i in $(seq "$KEEP" -1 2); do [ -f "$f.$((i-1)).gz" ] && mv -f "$f.$((i-1)).gz" "$f.$i.gz"; done
      gzip -c "$f" > "$f.1.gz" && : > "$f" && echo "      rotated ${f#"$ROOT"/} ($((size/1048576)) MB) -> .1.gz"
      chmod 600 "$f.1.gz" 2>/dev/null
      for i in $(seq $((KEEP+1)) $((KEEP+20))); do rm -f "$f.$i.gz"; done
    else echo "      would rotate ${f#"$ROOT"/} ($((size/1048576)) MB > ${MAXMB} MB), keeping $KEEP copies"; fi
  done
  [ "$did" = 0 ] && ok "no log in play/logs is over ${MAXMB} MB"
  # the old launcher's one-off build logs are never written again: compress the ones older than 3 days
  local old; old="$(find "$P/logs" -maxdepth 1 -name 'build-*.log' -mtime +3 2>/dev/null)"
  for f in $old; do
    if [ "$APPLY" = 1 ]; then gzip -f "$f" && echo "      compressed ${f#"$ROOT"/}"; else echo "      would compress ${f#"$ROOT"/}"; fi
  done
}

CMD="${1:-check}"; [ $# -gt 0 ] && shift
for a in "$@"; do [ "$a" = "--apply" ] && APPLY=1; done
[ "$CMD" = check ] || [ "$APPLY" = 1 ] || echo "(preview only: nothing is changed without --apply)"
case "$CMD" in
  check) perms check; leaks;;
  fix) perms fix;;
  rotate) rotate;;
  all) perms fix; leaks; rotate;;
  *) sed -n 2,10p "$0"; exit 64;;
esac
echo
echo "hygiene: $FAILS problem(s), $WARNS warning(s)"
[ "$FAILS" = 0 ]
