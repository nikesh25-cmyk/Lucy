#!/usr/bin/env bash
# NemoWorld inside Veloren: the merged, ready-to-play setup. Everything runs on this Mac, on 127.0.0.1.
#
#   play/play.sh setup            once: build folders, secrets, credentials, config, a fresh world, snapshot of the programs
#   play/play.sh start            start NemoWorld, the Veloren server, the relays and all eight residents
#   play/play.sh start --no-model same, without the local AI model (replies are scripted)
#   play/play.sh status           what is running
#   play/play.sh client           open the game window
#   play/play.sh admin NAME       give a player name admin rights on THIS local server (for /tp and /site)
#   play/play.sh stop             stop everything this script started
#   play/play.sh logs [name]      show the end of a log (server, nemo, relay-lw-lyra, resident-lw-kael, ...)
#   play/play.sh reset-world      stop, then delete the Veloren world and characters (keeps NemoWorld accounts and credentials)
#
# Ports: game server localhost:14004, NemoWorld http://127.0.0.1:3100. If the older Lyra-only test stack is running
# (dev/dev.sh) it is on the same ports: stop it first (dev/dev.sh stop).
set -u
ROOT="${HARR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
P="$ROOT/play"
SRC_V="$ROOT/wt/veloren-integ"          # merged Veloren tree (assets, roster, config templates)
SRC_N="$ROOT/wt/nemoworld-integ"        # merged NemoWorld tree (branch integration/all)
BUILD="$ROOT/wt/target/integ/release"   # merged builds
NODE="${NEMO_NODE:-$ROOT/../Lucy/.runtime/node-v24.19.0-darwin-arm64/node}"
NEMO_PORT=3100; VEL=14004; VEL_WEB=14005; VEL_Q=14006
NEMO="http://127.0.0.1:$NEMO_PORT"
# Laptop default: eight core residents plus twelve villagers. VILLAGE=all loads the full roster.
export VILLAGE="${VILLAGE:-12}"
ALL="lw-aria lw-theron lw-bram lw-lyra lw-kael lw-selene lw-vaelen lw-rowan"
VILLAGERS() { python3 - "$P/nemoworld/content/veloren-villagers.json" "${VILLAGE:-all}" <<'PYV'
import json,sys
ids=[r['id'] for r in json.load(open(sys.argv[1]))['residents']]
value=sys.argv[2]
if value=='all' or value=='1': selected=ids # preserve the old VILLAGE=1 default
elif value.isdecimal(): selected=ids[:int(value)]
else: sys.exit('VILLAGE must be all or a nonnegative count')
print(' '.join(selected))
PYV
}
ROLE_FLAG() { case "$1" in lw-selene) echo "--guide";; lw-kael) echo "--shop";; lw-rowan) echo "--home";; lw-vaelen) echo "--atlas";; *) echo "";; esac; }
NAME_OF() { case "$1" in lw-aria) echo Aria;; lw-theron) echo Theron;; lw-bram) echo Bram;; lw-lyra) echo Lyra;; lw-kael) echo Kael;; lw-selene) echo Selene;; lw-vaelen) echo Vaelen;; lw-rowan) echo Rowan;; esac; }
mkdir -p "$P"/{bin,data,logs,pids,secrets,userdata,nemoworld}; chmod 700 "$P/secrets"
export PATH="$HOME/.cargo/bin:$PATH"
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
stop_pid() { if alive "$1"; then kill "$(cat "$1")" 2>/dev/null; for _ in 1 2 3 4 5 6 7 8 9 10; do alive "$1" || break; sleep 1; done; fi; rm -f "$1"; }
link_env() { export NEMO_LINK_EVENT_KEY="$(cat "$P/secrets/event.key")" NEMO_WORLD_RECORD="$P/data/veloren-outbox.jsonl.world.json" LUCY_DATABASE="$P/data/world.sqlite" NEMO_LINK_DB="$P/data/veloren-link.sqlite" NEMO_LINK_COMMANDS="$P/data/veloren-outbox.jsonl.commands.jsonl"; }
issue() { # RESIDENT SCOPES TOKENFILE
  link_env
  (cd "$P/nemoworld" && "$NODE" scripts/veloren-link.mjs issue --resident "$1" --scopes "$2" --days 30 --label "play-$3" 2>/dev/null) | python3 -c "
import sys,json,os
d=json.load(sys.stdin); p='$P/secrets/$3'; open(p,'w').write(d['token']+'\n'); os.chmod(p,0o600)"
}
derive_uuid() { python3 -c "
import uuid,sys
s=144066263297769815596495629667062367629
for b in sys.argv[1].encode():
    s^=b; s=(s*309485009821345068724781371)%(1<<128)
print(uuid.UUID(int=s))" "$1"; }

case "${1:-help}" in
  preflight)
    python3 - "$P/userdata/server/server_config/settings.ron" "$P/userdata/server-cli/settings.ron" <<'PYLOCAL'
import ipaddress,re,sys
try:
    for file in sys.argv[1:]:
        text=open(file).read()
        sockets=re.findall(r'(?<![A-Za-z_])(?:address|query_address|web_address)\s*:\s*(?:Some\s*\(\s*)?"([^"]+)"',text)
        if not sockets: raise ValueError('no explicit socket settings')
        for endpoint in sockets:
            host,port=endpoint.rsplit(':',1)
            if not ipaddress.ip_address(host.strip('[]')).is_loopback or not 1<=int(port)<=65535:
                raise ValueError('nonlocal socket')
except (OSError,ValueError) as error:
    sys.exit('Unauthenticated Harr requires explicit loopback sockets; correct the local settings before starting.')
print('Loopback socket checks passed.')
PYLOCAL
    ;;
  setup)
    [ -x "$BUILD/veloren-server-cli" ] && [ -x "$BUILD/nemo-bridge" ] || { echo "merged builds missing in $BUILD" >&2; exit 1; }
    git -C "$ROOT/nemoworld" rev-parse -q --verify integration/all >/dev/null || { echo "branch integration/all missing" >&2; exit 1; }
    # Snapshot the programs so later work in the worktrees cannot change what you play.
    cp -f "$BUILD/veloren-server-cli" "$BUILD/nemo-bridge" "$P/bin/"
    rm -rf "$P/nemoworld" && mkdir -p "$P/nemoworld" && git -C "$ROOT/nemoworld" archive integration/all | tar -x -C "$P/nemoworld"
    [ -f "$P/secrets/event.key" ] || { head -c 32 /dev/urandom | xxd -p -c 64 > "$P/secrets/event.key"; chmod 600 "$P/secrets/event.key"; }
    # Veloren settings on the default ports, same world seed as the tested world (so Harr is where it was).
    mkdir -p "$P/userdata/server/server_config" "$P/userdata/server-cli"
    sed -e "s/14004/$VEL/g" -e "s/14006/$VEL_Q/g" "$ROOT/veloren/userdata/server/server_config/settings.ron" | sed -e "s/Global(PvP)/Global(PvE)/" -e "s/0\.0\.0\.0/127.0.0.1/g" -e "s/\[::\]/[::1]/g" > "$P/userdata/server/server_config/settings.ron"
    sed -e "s/14005/$VEL_WEB/" "$ROOT/veloren/userdata/server-cli/settings.template.ron" > "$P/userdata/server-cli/settings.ron"
    # One merged link config: eight residents, six landmarks, home, atlas and world dressing.
    python3 - "$ROOT" "$P" <<'PY'
import json,sys
root,p=sys.argv[1],sys.argv[2]
a=json.load(open(root+'/wt/run/integ/veloren-link.json')); w=json.load(open(root+'/wt/run/world/veloren-link.json'))
cfg={k:a[k] for k in ('server_id','ack_resident','home','atlas','world')}
cfg['outbox']=p+'/data/veloren-outbox.jsonl'
cfg['residents']=w['residents']
ids={l['id'] for l in a['landmarks']}
cfg['landmarks']=a['landmarks']+[l for l in w['landmarks'] if l['id'] not in ids]
n=p+'/nemoworld'
extra=json.load(open(n+'/content/veloren-landmarks-extra.json'))['landmarks']
have={l['id'] for l in cfg['landmarks']}
cfg['landmarks']+= [l for l in extra if l['id'] not in have]
cfg['atlas']={'path':n+'/content/veloren-atlas-places.json'}
cfg['world']={'enabled':True,'site':'Harr','path':n+'/content/veloren-world-harr.json'}
json.dump(cfg,open(p+'/veloren-link.json','w'),indent=2)
print('config: %d residents, %d landmarks'%(len(cfg['residents']),len(cfg['landmarks'])))
PY
    # The village: 24 scripted residents. They are added to the server's resident list (so they are never mistaken for
    # players) and to a roster for the bridge with their own lines left out, so they work quietly instead of chattering.
    python3 - "$P" <<'PY'
import json,sys
p=sys.argv[1]
cfg=json.load(open(p+'/veloren-link.json'))
v=json.load(open(p+'/nemoworld/content/veloren-villagers.json'))['residents']
for r in v: cfg['residents'][r['name'].split()[0]]=r['id']
json.dump(cfg,open(p+'/veloren-link.json','w'),indent=2)
roster=json.load(open(p+'/../wt/veloren-integ/nemo-bridge/roster.json'))
ids={r['id'] for r in roster['residents']}
roster['residents']+=[dict(r,barks=[]) for r in v if r['id'] not in ids]
json.dump(roster,open(p+'/data/roster-all.json','w'))
print('village: %d residents added (%d in the roster file)'%(len(v),len(roster['residents'])))
PY
    # Credentials: each resident gets a bridge credential and its own events credential for its relay.
    for id in $ALL; do
      sc="talk,director"; [ "$id" = lw-kael ] && sc="talk,director,shop"
      [ -f "$P/secrets/bridge-$id.token" ] || issue "$id" "$sc" "bridge-$id.token"
      [ -f "$P/secrets/events-$id.token" ] || issue "$id" events "events-$id.token"
    done
    for id in $(VILLAGERS); do [ -f "$P/secrets/bridge-$id.token" ] || issue "$id" "talk,director" "bridge-$id.token"; done
    ls "$P/secrets" | wc -l | xargs echo "secrets files:"
    echo "setup done. Next: play/play.sh start"
    ;;
  start)
    [ -x "$P/bin/veloren-server-cli" ] || { echo "run: play/play.sh setup" >&2; exit 1; }
    "$0" preflight || exit 1
    for port in $NEMO_PORT $VEL; do lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1 && ! alive "$P/pids/veloren" && ! alive "$P/pids/nemo" && { echo "port $port is already in use (the older test stack?). Run dev/dev.sh stop, then try again." >&2; exit 1; }; done
    "$0" stop >/dev/null 2>&1
    [ "${2:-}" = "--no-model" ] && export NEMO_NO_MODEL=1 || export NEMO_NO_MODEL=0
    ( cd "$ROOT" && NEMO_WORLD_RECORD="$P/data/veloren-outbox.jsonl.world.json" NEMO_ROOT="$P/nemoworld" NEMO_PORT="$NEMO_PORT" NEMO_DEV_DIR="$P" NEMO_AI_ROOT="$ROOT/../Lucy" exec nohup "$NODE" dev/start-nemo.mjs < /dev/null > "$P/logs/nemo.log" 2>&1 ) & echo $! > "$P/pids/nemo"; disown
    echo "starting NemoWorld${NEMO_NO_MODEL:+ (model: $([ "$NEMO_NO_MODEL" = 1 ] && echo off || echo on))}..."
    for _ in $(seq 1 240); do curl -s -m2 -o /dev/null "$NEMO/api/v1/health" && break; sleep 1; done
    curl -s -m3 -o /dev/null "$NEMO/api/v1/health" || { echo "NemoWorld did not start; see $P/logs/nemo.log" >&2; exit 1; }
    echo "starting the Veloren server (world generation takes about a minute)..."
    ( cd "$SRC_V" && VELOREN_USERDATA="$P/userdata" NEMO_LINK_CONFIG="$P/veloren-link.json" NEMO_LINK_EVENT_KEY="$(cat "$P/secrets/event.key")" exec nohup "$P/bin/veloren-server-cli" --non-interactive --no-auth < /dev/null > "$P/logs/server.log" 2>&1 ) & echo $! > "$P/pids/veloren"; disown
    for _ in $(seq 1 300); do grep -q "ready to accept" "$P/logs/server.log" 2>/dev/null && break; sleep 1; done
    grep -q "ready to accept" "$P/logs/server.log" || { echo "the Veloren server did not come up; see $P/logs/server.log" >&2; exit 1; }
    LM="$P/data/veloren-outbox.jsonl.landmarks.json"
    for _ in $(seq 1 40); do [ -f "$LM" ] && break; sleep 1; done
    echo "starting the relays and the eight residents..."
    for id in $ALL; do
      ( cd "$P/nemoworld" && NEMO_LINK_TOKEN="$(cat "$P/secrets/events-$id.token")" exec nohup "$NODE" scripts/veloren-relay.mjs --outbox "$P/data/veloren-outbox.jsonl" --url "$NEMO" --resident "$id" < /dev/null > "$P/logs/relay-$id.log" 2>&1 ) & echo $! > "$P/pids/relay-$id"; disown
    done
    for id in $ALL; do
      ( cd "$SRC_V" && VELOREN_USERDATA="$P/userdata" RUST_LOG="warn,nemo_bridge=info" NEMO_LINK_TOKEN="$(cat "$P/secrets/bridge-$id.token")" exec nohup "$P/bin/nemo-bridge" --server "localhost:$VEL" --resident "$id" $(ROLE_FLAG "$id") --roster "$P/data/roster-all.json" --tps 12 --landmarks "$LM" --nemo-url "$NEMO" < /dev/null > "$P/logs/resident-$id.log" 2>&1 ) & echo $! > "$P/pids/res-$id"; disown
      sleep 3
    done
    for id in $(VILLAGERS); do
      ( cd "$SRC_V" && VELOREN_USERDATA="$P/userdata" RUST_LOG="warn,nemo_bridge=info" NEMO_LINK_TOKEN="$(cat "$P/secrets/bridge-$id.token")" exec nohup "$P/bin/nemo-bridge" --server "localhost:$VEL" --resident "$id" --roster "$P/data/roster-all.json" --tps 12 --landmarks "$LM" --nemo-url "$NEMO" < /dev/null > "$P/logs/resident-$id.log" 2>&1 ) & echo $! > "$P/pids/res-$id"; disown
      sleep 2
    done
    echo
    "$0" status
    echo
    echo "READY. Open the game: play/play.sh client   (Multiplayer, server: localhost)"
    echo "NemoWorld in your browser: $NEMO   (create your account there; it is also where you link and confirm purchases)"
    ;;
  status)
    for n in nemo veloren; do printf '%-14s' "$n"; alive "$P/pids/$n" && echo "running" || echo "stopped"; done
    for id in $ALL; do printf '%-14s' "$(NAME_OF $id)"; alive "$P/pids/res-$id" && printf 'resident up, ' || printf 'resident DOWN, '; alive "$P/pids/relay-$id" && echo "relay up" || echo "relay DOWN"; done
    v=0; vt=0; for id in $(VILLAGERS); do vt=$((vt+1)); alive "$P/pids/res-$id" && v=$((v+1)); done; [ $vt -gt 0 ] && echo "village       $v of $vt villagers up"
    grep -q "ready to accept" "$P/logs/server.log" 2>/dev/null && echo "server: ready ($(grep -c 'New User' "$P/logs/server.log") logins so far)"
    ;;
  client)
    CLIENT="$ROOT/wt/target/integ/release/veloren-voxygen"; [ -x "$CLIENT" ] || CLIENT="$ROOT/veloren/target/release/veloren-voxygen"; [ -x "$CLIENT" ] || { echo "game client not found at $CLIENT" >&2; exit 1; }
    ( cd "$SRC_V" && VELOREN_ASSETS="$SRC_V/assets" VELOREN_USERDATA="$P/userdata" nohup "$CLIENT" < /dev/null > "$P/logs/client.log" 2>&1 & ); disown 2>/dev/null
    echo "game window opening. Choose MULTIPLAYER (not Singleplayer), server: localhost, and press H in-game for the Harr panel."
    ;;
  admin)
    NAME="${2:?player name}"; U="$(derive_uuid "$NAME")"
    python3 - "$P/userdata/server/server_config/admins.ron" "$U" "$NAME" <<'PY'
import sys,re,os
p,u,n=sys.argv[1:4]
entry='    "%s": (\n        username_when_admined: Some("%s"),\n        date: "2026-01-01T00:00:00Z",\n        role: Admin,\n    ),\n'%(u,n)
txt=open(p).read() if os.path.exists(p) else 'V1({\n})'
if u in txt: print('already admin'); sys.exit()
txt=txt.rstrip()
txt=txt[:txt.rindex('})')]+entry+'})' if txt.endswith('})') else 'V1({\n'+entry+'})'
open(p,'w').write(txt); print('admin added for',n,u)
PY
    echo "Restart for it to take effect: play/play.sh stop && play/play.sh start"
    ;;
  stop)
    for f in "$P"/pids/res-* "$P"/pids/relay-*; do [ -e "$f" ] && stop_pid "$f"; done
    stop_pid "$P/pids/veloren"; stop_pid "$P/pids/nemo"; sleep 1; echo "stopped";;
  logs)
    f="$P/logs/${2:-server}.log"; [ -f "$f" ] || { ls "$P/logs"; exit 1; }; tail -40 "$f" | sed -E 's/\x1b\[[0-9;]*m//g' | cut -c1-220;;
  reset-world)
    "$0" stop >/dev/null 2>&1
    rm -rf "$P/userdata/server/saves" "$P/userdata/server/rtsim" "$P/data/veloren-outbox.jsonl"*
    echo "Veloren world and characters deleted. NemoWorld accounts, links and credentials were kept."
    ;;
  *) sed -n 2,14p "$0";;
esac
