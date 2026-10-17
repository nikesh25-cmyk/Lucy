#!/usr/bin/env bash
# verify.sh: end-to-end smoke test of a RUNNING Harr. Read-only: it only GETs, reads files and greps logs.
#
#   ops/verify.sh [--quick] [--json]       run all checks, print PASS / FAIL / WARN / SKIP per check
#
# Checks: NemoWorld health, the harr health endpoint, the game server, the guide (Selene) pages read with her
# credential from play/secrets (the token is passed to curl through a private temp file and is never printed),
# the dashboard overview JSON shape, the works record (stages built, crews), the pantry shelf, residents up,
# and that the logs contain no panics.
#
# Exit code: 0 when nothing FAILED (WARN and SKIP do not fail), 1 when something FAILED, 3 when the world is not running.
# --quick skips the page-by-page Selene loop (three pages instead of eight). --json prints one JSON summary at the end.
# Environment: HARR_ROOT (folder containing play/), NEMO_PORT, HARR_VEL_PORT, HARR_GUIDE_TOKEN_FILE (default play/secrets/bridge-lw-selene.token).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${HARR_ROOT:-$(cd "$HERE/.." && pwd)}"
P="$ROOT/play"
LIB="$HERE/lib/harr_ops.py"; [ -f "$LIB" ] || LIB="$P/lib/harr_ops.py"
NEMO="http://127.0.0.1:${NEMO_PORT:-3100}"; VEL="${HARR_VEL_PORT:-14004}"
TOKEN_FILE="${HARR_GUIDE_TOKEN_FILE:-$P/secrets/bridge-lw-selene.token}"
QUICK=0; JSON=0
for a in "$@"; do case "$a" in --quick) QUICK=1;; --json) JSON=1;; -h|--help) sed -n 2,13p "$0"; exit 0;; *) echo "unknown option $a" >&2; exit 64;; esac; done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/harr-verify.XXXXXX")"; chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
HDR="$TMP/auth.hdr"
PASS=0; FAILS=0; WARNS=0; SKIPS=0; RESULTS=""

# Authorization header in a private file so the token never appears on a command line or in output.
HAVE_TOKEN=0
if [ -r "$TOKEN_FILE" ]; then
  ( umask 077; printf 'Authorization: Bearer %s\n' "$(tr -d '\n' < "$TOKEN_FILE")" > "$HDR" ); HAVE_TOKEN=1
fi

report() { # LEVEL NAME DETAIL
  printf '%-5s %-26s %s\n' "$1" "$2" "$3"
  case "$1" in PASS) PASS=$((PASS+1));; FAIL) FAILS=$((FAILS+1));; WARN) WARNS=$((WARNS+1));; SKIP) SKIPS=$((SKIPS+1));; esac
  RESULTS="$RESULTS$1|$2|$3
"
}
get() { # URL OUTFILE [auth]  -> prints the HTTP status (000 when unreachable)
  if [ "${3:-}" = auth ]; then curl -s -m6 -o "$2" -w '%{http_code}' -H @"$HDR" "$1" 2>/dev/null || echo 000
  else curl -s -m6 -o "$2" -w '%{http_code}' "$1" 2>/dev/null || echo 000; fi
}
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
pyj() { python3 -c "$@"; }

echo "Harr smoke test against $NEMO  ($(date '+%Y-%m-%d %H:%M:%S'))"
echo

# --- 0. is anything running -------------------------------------------------------------------------
if ! alive "$P/pids/nemo" && ! alive "$P/pids/veloren"; then
  echo "Harr is not running (no NemoWorld or Veloren process from play/pids). Start it, then run this again." >&2
  exit 3
fi

# --- 1. NemoWorld ------------------------------------------------------------------------------------
c=$(get "$NEMO/api/v1/health" "$TMP/health.json")
[ "$c" = 200 ] && report PASS "nemoworld health" "HTTP 200" || report FAIL "nemoworld health" "HTTP $c from $NEMO/api/v1/health (see play/logs/nemo.log)"

# --- 2. harr health endpoint (additive; older builds do not have it) --------------------------------
c=$(get "$NEMO/api/v1/veloren/harr/health" "$TMP/hh.json")
case "$c" in
  200) r=$(pyj "import json;d=json.load(open('$TMP/hh.json'));g=lambda v:'never' if v is None else '%ss'%v;print(('ok' if d.get('ok') and d['db']['ok'] and d['link']['ok'] else 'bad')+'|db ok, link ok; last game event '+g(d['events']['last_event_age_s'])+' ago, works record '+g(d['works_record']['age_s'])+' old'+('; warnings: '+'; '.join(d['warnings']) if d['warnings'] else ''))")
       case "$r" in ok*) report PASS "harr health" "${r#ok|}";; *) report FAIL "harr health" "${r#bad|}";; esac;;
  404) report SKIP "harr health" "this build has no /veloren/harr/health yet (proposal in src/veloren-ext/health.js)";;
  503) report FAIL "harr health" "HTTP 503: database or link not working: $(pyj "import json;print(';'.join(json.load(open('$TMP/hh.json'))['warnings']))" 2>/dev/null)";;
  *)   report FAIL "harr health" "HTTP $c";;
esac

# --- 3. game server ----------------------------------------------------------------------------------
if alive "$P/pids/veloren" && grep -q "ready to accept" "$P/logs/server.log" 2>/dev/null; then
  if nc -z -w2 127.0.0.1 "$VEL" 2>/dev/null; then report PASS "game server" "running, ready, port $VEL accepting connections"
  else report FAIL "game server" "process is up and says ready, but port $VEL refuses connections"; fi
else
  report FAIL "game server" "not running or not ready (play/logs/server.log)"
fi

# --- 4. guide credential + link status ---------------------------------------------------------------
if [ "$HAVE_TOKEN" = 1 ]; then
  c=$(get "$NEMO/api/v1/veloren/status" "$TMP/status.json" auth)
  if [ "$c" = 200 ]; then report PASS "guide credential" "accepted; $(pyj "import json;d=json.load(open('$TMP/status.json'));print(d['events'],'events,',d['players'],'players,',d['credentials_active'],'credentials active')")"
  else report FAIL "guide credential" "HTTP $c (expired or revoked? re-issue with play/play.sh setup)"; HAVE_TOKEN=0; fi
else
  report SKIP "guide credential" "no readable token at ${TOKEN_FILE#"$ROOT"/}"
fi

# --- 5. Selene pages ----------------------------------------------------------------------------------
if [ "$HAVE_TOKEN" = 1 ]; then
  pages="works pantry today"; [ "$QUICK" = 1 ] || pages="works pantry today chronicle tasks purpose research library"
  n=0
  for pg in $pages; do
    n=$((n+1)); uuid=$(printf '00000000-0000-4000-8000-%012d' "$n")     # a different probe id per page: the per-player rate gap is 1 s
    c=$(get "$NEMO/api/v1/veloren/view/$pg?player_uuid=$uuid" "$TMP/page.json" auth)
    if [ "$c" != 200 ]; then report FAIL "selene page: $pg" "HTTP $c"; continue; fi
    r=$(pyj "
import json
d=json.load(open('$TMP/page.json'))
ok=isinstance(d.get('lines'),list) and d['lines'] and all(isinstance(l,str) and len(l)<=256 for l in d['lines']) and d.get('command')=='$pg' and d.get('source')=='scripted'
print(('ok' if ok else 'bad')+'|'+str(len(d.get('lines',[])))+' lines, page '+str(d.get('page'))+' of '+str(d.get('pages')))")
    case "$r" in ok*) report PASS "selene page: $pg" "${r#ok|}";; *) report FAIL "selene page: $pg" "unexpected shape: $r";; esac
  done
fi

# --- 6. dashboard overview JSON shape ------------------------------------------------------------------
c=$(get "$NEMO/api/v1/veloren/harr/overview" "$TMP/overview.json")
if [ "$c" != 200 ]; then report FAIL "dashboard overview" "HTTP $c"; else
  r=$(pyj "
import json
d=json.load(open('$TMP/overview.json'))
miss=[k for k in ('generated_at','purpose','research','works','pantry','rhythm','chronicle','roles','library') if k not in d]
bad=[]
if not miss:
    if not isinstance(d['purpose'].get('goals'),list) or not d['purpose'].get('name'): bad.append('purpose')
    r=d['research']
    if not isinstance(r.get('techs'),list) or not r['techs'] or not all(k in r for k in ('insight','learned','total')): bad.append('research')
    if not isinstance(d['works'],list) or not d['works'] or not all(all(k in w for k in ('id','name','done','total','complete')) for w in d['works']): bad.append('works')
    if not isinstance(d['pantry'].get('shelves'),str): bad.append('pantry')
    if not isinstance(d['rhythm'],list) or not isinstance(d['roles'],list) or not isinstance(d['library'],list): bad.append('lists')
    leak=json.dumps(d)
    for w in ('player_uuid','token','signature'):
        if w in leak: bad.append('leaks '+w)
print('bad|missing keys: '+','.join(miss) if miss else ('bad|wrong shape: '+','.join(bad) if bad else 'ok|%d works, %d techs (%d learned), %d roles, %d library entries'%(len(d['works']),len(d['research']['techs']),d['research']['learned'],len(d['roles']),len(d['library']))))")
  case "$r" in ok*) report PASS "dashboard overview" "${r#ok|}";; *) report FAIL "dashboard overview" "${r#bad|}";; esac
fi

# --- 7. works record -----------------------------------------------------------------------------------
REC="$P/data/veloren-outbox.jsonl.world.json"
if [ ! -f "$REC" ]; then report FAIL "works record" "missing: $REC"; else
  r=$(pyj "
import json,time
try: d=json.load(open('$REC'))
except Exception as e: print('bad|unreadable: %s'%e); raise SystemExit
if d.get('format')!='veloren-world-applied-v1': print('bad|unknown format %r'%d.get('format')); raise SystemExit
built=[k for k in d['groups'] if k[-1:].isdigit()]
w=list(d.get('waiting',{}).values())
age=round(time.time()-d['updated_at']/1000) if d.get('updated_at') else None
lvl='ok' if age is not None and age<600 else 'old'
print('%s|%d stages built, %d groups total, %d waiting (%d crew, %d chunks not loaded, %d not yet due), clock %d min, record %s old'%(lvl,len(built),len(d['groups']),len(w),sum('crew' in str(x) for x in w),sum('chunks' in str(x) for x in w),sum('not due' in str(x) for x in w),(d.get('works_elapsed_ms') or 0)/60000,('%ds'%age) if age is not None else 'of unknown age'))")
  case "$r" in
    ok*) report PASS "works record" "${r#ok|}";;
    old*) report WARN "works record" "${r#old|}  (the game server rewrites it about once a minute: stale record, see OPERATIONS.md)";;
    *) report FAIL "works record" "${r#bad|}";;
  esac
  # the overview and the record must tell the same story: stages built per the record >= stages done per the overview
  if [ -f "$TMP/overview.json" ]; then
    r=$(pyj "
import json
o=json.load(open('$TMP/overview.json')); d=json.load(open('$REC'))
done=sum(w['done'] for w in o['works']); built=len([k for k in d['groups'] if k[-1:].isdigit()])
crew=[w['name'] for w in o['works'] if w.get('next') and w['next'].get('waiting')]
print(('ok' if done<=built+len(o['works']) else 'bad')+'|overview counts %d stages done, record has %d built; waiting for a crew: %s'%(done,built,', '.join(crew) or 'none'))" 2>&1)
    case "$r" in ok*) report PASS "works: overview vs record" "${r#ok|}";; *) report WARN "works: overview vs record" "${r#bad|}";; esac
  fi
fi

# --- 8. pantry shelf -----------------------------------------------------------------------------------
if [ -f "$TMP/overview.json" ]; then
  r=$(pyj "
import json,re
try: s=json.load(open('$TMP/overview.json'))['pantry']['shelves']
except Exception: s='(no pantry in the overview)'
ok=all(re.search(r'\d+ '+w,s) for w in ('apples','carrots','cheese','lettuces'))
print(('ok|' if ok else 'bad|')+s)")
  case "$r" in ok*) report PASS "pantry shelf" "${r#ok|}";; *) report FAIL "pantry shelf" "unexpected shelf text: ${r#bad|}";; esac
fi

# --- 9. residents ---------------------------------------------------------------------------------------
r=$(python3 "$LIB" status --json 2>/dev/null | pyj "
import json,sys
d=json.load(sys.stdin); p=d['processes']
down=len(p['down'])
print(('ok' if down==0 else 'down')+'|%d/%d relays, %d/%d core residents, %d/%d villagers%s'%(p['relays']['up'],p['relays']['expected'],p['residents']['up'],p['residents']['expected'],p['villagers']['up'],p['villagers']['expected'],'' if not down else '; down: '+', '.join(p['down'][:6])))" 2>/dev/null)
case "$r" in ok*) report PASS "residents" "${r#ok|}";; down*) report WARN "residents" "${r#down|}";; *) report SKIP "residents" "status helper unavailable";; esac

# --- 10. no panics in logs -------------------------------------------------------------------------------
bad=""; total=0
for f in "$P"/logs/server.log "$P"/logs/nemo.log "$P"/logs/resident-*.log "$P"/logs/relay-*.log; do
  [ -f "$f" ] || continue
  n=$(grep -c "panicked" "$f" 2>/dev/null); n=${n:-0}
  if [ "$n" -gt 0 ]; then total=$((total+n)); bad="$bad ${f##*/}($n)"; fi
done
if [ "$total" = 0 ]; then report PASS "no panics in logs" "server, nemo, relay and resident logs clean"
else report FAIL "no panics in logs" "$total panic line(s) in:$bad  (first: $(grep -h -m1 panicked "$P"/logs/server.log 2>/dev/null | sed -E 's/\x1b\[[0-9;]*m//g' | cut -c1-120))"; fi

echo
echo "Result: $PASS passed, $FAILS failed, $WARNS warnings, $SKIPS skipped"
if [ "$JSON" = 1 ]; then
  printf '%s' "$RESULTS" | python3 -c "
import json,sys
rows=[l.split('|',2) for l in sys.stdin.read().splitlines() if l]
print(json.dumps({'pass':sum(r[0]=='PASS' for r in rows),'fail':sum(r[0]=='FAIL' for r in rows),'checks':[{'level':a,'name':b,'detail':c} for a,b,c in rows]},indent=2))"
fi
[ "$FAILS" = 0 ]
