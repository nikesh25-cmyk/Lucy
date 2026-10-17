#!/usr/bin/env python3
"""Probes and reports for the Harr operations scripts (ops/play-next.sh, ops/soak.sh, ops/verify.sh).

Read-only: this file never starts, stops or changes anything. Standard library only.

  harr_ops.py preflight [--model|--no-model] [--light] [--village N] [--force-ports]
        prints OK / WARN / FAIL lines; exit 0 = fine, 3 = warnings only, 2 = refuse
  harr_ops.py status [--json]
  harr_ops.py watch-line            one line for `watch`: load, memory, processes, works, new errors
  harr_ops.py sample                one CSV row for ops/soak.sh (header: harr_ops.py sample --header)
  harr_ops.py system                the machine facts alone, as JSON

Environment: HARR_ROOT (the lyra-integration folder; default: the parent of this script's folder, or of play/),
NEMO_PORT, HARR_NEMO (base url). For tests, every probe can be faked:
  HARR_T_CPUS, HARR_T_LOAD, HARR_T_AVAIL_MB, HARR_T_SWAP_MB, HARR_T_DISK_GB, HARR_T_PROCS ("cargo rustc"), HARR_T_BUSY_PORTS ("3100 14004")
Thresholds can be overridden with HARR_MIN_DISK_WARN_GB etc. (see THRESHOLDS).
"""
import hashlib, json, os, re, subprocess, sys, time, shutil, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))


def find_root():
    """The folder that contains play/play.sh, found by walking up from this file (works from ops/, play/ops/ or a worktree)."""
    if os.environ.get("HARR_ROOT"):
        return os.environ["HARR_ROOT"]
    d = HERE
    while d != os.path.dirname(d):
        if os.path.isfile(os.path.join(d, "play", "play.sh")):
            return d
        d = os.path.dirname(d)
    return os.path.dirname(os.path.dirname(HERE))


ROOT = find_root()
P = os.path.join(ROOT, "play")
NEMO_PORT = int(os.environ.get("NEMO_PORT", "3100"))
NEMO = os.environ.get("HARR_NEMO", "http://127.0.0.1:%d" % NEMO_PORT)
PORTS = {NEMO_PORT: "NemoWorld", 14004: "Veloren game", 14005: "Veloren web", 14006: "Veloren query"}
CORE = ["lw-aria", "lw-theron", "lw-bram", "lw-lyra", "lw-kael", "lw-selene", "lw-vaelen", "lw-rowan"]
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def env_num(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return float(default)


# (warn, refuse) -- for "free" values refuse is lower than warn; for "used" values refuse is higher.
THRESHOLDS = {
    "disk_gb": (env_num("HARR_MIN_DISK_WARN_GB", 15), env_num("HARR_MIN_DISK_FAIL_GB", 5)),
    "mem_model_mb": (env_num("HARR_MEM_MODEL_WARN_MB", 5000), env_num("HARR_MEM_MODEL_FAIL_MB", 2500)),
    "mem_plain_mb": (env_num("HARR_MEM_WARN_MB", 2500), env_num("HARR_MEM_FAIL_MB", 1200)),
    "mem_light_mb": (env_num("HARR_MEM_LIGHT_WARN_MB", 1800), env_num("HARR_MEM_LIGHT_FAIL_MB", 900)),
    "swap_mb": (env_num("HARR_SWAP_WARN_MB", 3000), env_num("HARR_SWAP_FAIL_MB", 8000)),
    "load_per_cpu": (env_num("HARR_LOAD_WARN_PER_CPU", 0.8), env_num("HARR_LOAD_FAIL_PER_CPU", 1.6)),
}


def sh(*args, timeout=5):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ""


# ---- machine facts -------------------------------------------------------------------------------

def cpus():
    if os.environ.get("HARR_T_CPUS"):
        return int(os.environ["HARR_T_CPUS"])
    return os.cpu_count() or 1


def load_avg():
    if os.environ.get("HARR_T_LOAD"):
        v = float(os.environ["HARR_T_LOAD"]); return v, v, v
    try:
        return os.getloadavg()
    except OSError:
        return 0.0, 0.0, 0.0


def mem_available_mb():
    """macOS: free + inactive + speculative + purgeable pages (what the system can hand out without swapping)."""
    if os.environ.get("HARR_T_AVAIL_MB"):
        return float(os.environ["HARR_T_AVAIL_MB"])
    out = sh("vm_stat")
    if out:
        m = re.search(r"page size of (\d+) bytes", out)
        size = int(m.group(1)) if m else 4096
        pages = 0
        for key in ("Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"):
            m = re.search(re.escape(key) + r":\s+(\d+)", out)
            if m:
                pages += int(m.group(1))
        return pages * size / 1048576
    try:  # Linux
        for line in open("/proc/meminfo"):
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) / 1024
    except OSError:
        pass
    return None


def mem_total_mb():
    out = sh("sysctl", "-n", "hw.memsize").strip()
    return int(out) / 1048576 if out.isdigit() else None


def swap_used_mb():
    if os.environ.get("HARR_T_SWAP_MB"):
        return float(os.environ["HARR_T_SWAP_MB"])
    out = sh("sysctl", "-n", "vm.swapusage")      # total = 4096.00M  used = 1822.25M  free = ...
    m = re.search(r"used = ([\d.]+)([MGK])", out)
    if not m:
        return None
    v = float(m.group(1))
    return v * {"K": 1 / 1024, "M": 1, "G": 1024}[m.group(2)]


def disk_free_gb(path=None):
    if os.environ.get("HARR_T_DISK_GB"):
        return float(os.environ["HARR_T_DISK_GB"])
    path = path or (P if os.path.isdir(P) else ROOT)
    try:
        return shutil.disk_usage(path).free / 1e9
    except OSError:
        return None


def ps_rows():
    rows = []
    for line in sh("ps", "-axo", "pid=,rss=,args=").splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            rows.append((int(parts[0]), int(parts[1]), parts[2]))
    return rows


def build_processes(rows=None):
    """Names of compiler processes that would fight the game for CPU."""
    if os.environ.get("HARR_T_PROCS") is not None:
        return [p for p in os.environ["HARR_T_PROCS"].split() if p]
    found = set()
    for _pid, _rss, args in (rows if rows is not None else ps_rows()):
        exe = os.path.basename(args.split(None, 1)[0])
        if exe in ("cargo", "rustc", "cc1", "clang", "ld", "rust-lld"):
            found.add(exe)
    return sorted(found)


def listening(port):
    if os.environ.get("HARR_T_BUSY_PORTS") is not None:
        return str(port) in os.environ["HARR_T_BUSY_PORTS"].split()
    return bool(sh("lsof", "-nP", "-iTCP:%d" % port, "-sTCP:LISTEN", timeout=4).strip())


def system_facts():
    l1, l5, l15 = load_avg()
    return {
        "load1": round(l1, 2), "load5": round(l5, 2), "load15": round(l15, 2), "cpus": cpus(),
        "mem_available_mb": round(mem_available_mb() or 0) if mem_available_mb() is not None else None,
        "mem_total_mb": round(mem_total_mb() or 0) or None,
        "swap_used_mb": round(swap_used_mb() or 0) if swap_used_mb() is not None else None,
        "disk_free_gb": round(disk_free_gb() or 0, 1) if disk_free_gb() is not None else None,
        "build_processes": build_processes(),
    }


# ---- our own processes ---------------------------------------------------------------------------

def alive(pidfile):
    try:
        pid = int(open(pidfile).read().strip())
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        return False


def villager_ids(limit=None):
    try:
        data = json.load(open(os.path.join(P, "nemoworld/content/veloren-villagers.json")))
        ids = [r["id"] for r in data["residents"]]
    except (OSError, ValueError, KeyError):
        ids = []
    if limit is not None:
        ids = ids[:limit]
    return ids


def read_mode():
    try:
        return json.load(open(os.path.join(P, "pids/mode.json")))
    except (OSError, ValueError):
        return {}


def expected_village(mode=None):
    mode = read_mode() if mode is None else mode
    n = mode.get("village")
    return villager_ids(None if n in (None, "all") else int(n))


def tail_text(path, nbytes=200_000):
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - nbytes))
            return ANSI.sub("", f.read().decode("utf-8", "replace"))
    except OSError:
        return ""


def count_in(path, needle):
    try:
        with open(path, "rb") as f:
            return f.read().count(needle.encode())
    except OSError:
        return 0


def http_json(url, timeout=2):
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            return e.code, None
    except Exception:
        return None, None


def works_progress():
    f = os.path.join(P, "data/veloren-outbox.jsonl.world.json")
    try:
        d = json.load(open(f))
    except (OSError, ValueError):
        return None
    waiting = list((d.get("waiting") or {}).values())
    return {
        "stages_built": len([k for k in (d.get("groups") or {}) if k[-1:].isdigit()]),
        "waiting_for_crew": sum("crew" in str(w) for w in waiting),
        "not_yet_due": sum("not due" in str(w) for w in waiting),
        "chunks_not_loaded": sum("chunks_not_loaded" in str(w) for w in waiting),
        "clock_minutes": round((d.get("works_elapsed_ms") or 0) / 60000),
        "record_age_s": round(time.time() - d["updated_at"] / 1000) if d.get("updated_at") else None,
    }


def status():
    mode = read_mode()
    core_up = [i for i in CORE if alive(os.path.join(P, "pids/res-" + i))]
    relay_up = [i for i in CORE if alive(os.path.join(P, "pids/relay-" + i))]
    vil = expected_village(mode)
    vil_up = [i for i in vil if alive(os.path.join(P, "pids/res-" + i))]
    nemo_up = alive(os.path.join(P, "pids/nemo"))
    vel_up = alive(os.path.join(P, "pids/veloren"))
    log = os.path.join(P, "logs/server.log")
    ready = vel_up and count_in(log, "ready to accept") > 0
    panics = count_in(log, "panicked")
    code, body = http_json(NEMO + "/api/v1/health")
    hcode, hbody = http_json(NEMO + "/api/v1/veloren/harr/health")
    down = [("resident " + i) for i in CORE if i not in core_up] + [("relay " + i) for i in CORE if i not in relay_up] + [("villager " + i) for i in vil if i not in vil_up]
    if not nemo_up: down.insert(0, "nemo")
    if not vel_up: down.insert(0, "veloren")
    if not nemo_up and not vel_up:
        overall = "stopped"
    elif not nemo_up or not vel_up or not ready:
        overall = "down"
    elif down or panics or (hcode == 503):
        overall = "degraded"
    else:
        overall = "ok"
    backups = sorted(f for f in os.listdir(os.path.join(P, "backups"))) if os.path.isdir(os.path.join(P, "backups")) else []
    return {
        "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "overall": overall,
        "mode": mode,
        "processes": {
            "nemo": nemo_up, "veloren": vel_up,
            "relays": {"up": len(relay_up), "expected": len(CORE)},
            "residents": {"up": len(core_up), "expected": len(CORE)},
            "villagers": {"up": len(vil_up), "expected": len(vil)},
            "down": down,
        },
        "server": {"ready": ready, "logins": count_in(log, "New User"), "panics": panics},
        "nemoworld": {"health_http": code, "harr_health_http": hcode, "harr_health": hbody if hcode in (200, 503) else None},
        "works": works_progress(),
        "system": system_facts(),
        "last_backup": backups[-1] if backups else None,
    }


def human_status(s):
    p, sysf, srv = s["processes"], s["system"], s["server"]
    mode = s["mode"] or {}
    out = ["Harr is %s%s" % (s["overall"].upper(), (" (" + mode.get("label", "") + ")") if mode.get("label") else "")]
    out.append("  NemoWorld   %s%s" % ("running" if p["nemo"] else "stopped", "" if s["nemoworld"]["health_http"] == 200 else (" (health: no answer)" if p["nemo"] else "")))
    out.append("  Veloren     %s%s" % ("running" if p["veloren"] else "stopped", ", ready, %d logins so far" % srv["logins"] if srv["ready"] else (", not ready yet" if p["veloren"] else "")))
    out.append("  Relays      %d of %d up" % (p["relays"]["up"], p["relays"]["expected"]))
    out.append("  Residents   %d of %d core up, %d of %d villagers up" % (p["residents"]["up"], p["residents"]["expected"], p["villagers"]["up"], p["villagers"]["expected"]))
    if p["down"] and s["overall"] != "stopped":
        out.append("  DOWN:       " + ", ".join(p["down"][:8]) + (" ... (+%d more)" % (len(p["down"]) - 8) if len(p["down"]) > 8 else ""))
    out.append("  Errors      %d panics in server.log" % srv["panics"])
    w = s["works"]
    if w:
        out.append("  Works       %d stages built, %d waiting for a crew, %d not yet due, open-world clock %d min%s" % (
            w["stages_built"], w["waiting_for_crew"], w["not_yet_due"], w["clock_minutes"],
            ", record %ds old" % w["record_age_s"] if w["record_age_s"] is not None else ""))
    out.append("  Machine     load %.1f/%d cpus, %s MB memory available, swap used %s MB, disk %s GB free%s" % (
        sysf["load1"], sysf["cpus"], sysf["mem_available_mb"], sysf["swap_used_mb"], sysf["disk_free_gb"],
        ", COMPILER RUNNING: " + ",".join(sysf["build_processes"]) if sysf["build_processes"] else ""))
    out.append("  Last backup %s" % (s["last_backup"] or "none"))
    return "\n".join(out)


# ---- pre-flight ----------------------------------------------------------------------------------

def preflight(args):
    model = "--model" in args or not ("--no-model" in args or "--lite" in args)
    light = "--light" in args
    force_ports = "--force-ports" in args
    results = []   # (level, name, message)

    def add(level, name, msg):
        results.append((level, name, msg))

    def judge_low(name, value, warn, fail, unit, advice):
        if value is None:
            add("WARN", name, "could not be measured")
        elif value < fail:
            add("FAIL", name, "%.0f %s is too little (need %.0f). %s" % (value, unit, fail, advice))
        elif value < warn:
            add("WARN", name, "%.0f %s is low (comfortable above %.0f). %s" % (value, unit, warn, advice))
        else:
            add("OK", name, "%.0f %s" % (value, unit))

    judge_low("disk", disk_free_gb(), *THRESHOLDS["disk_gb"], "GB free", "Delete old play/backups or logs (ops/hygiene.sh rotate), or free space elsewhere.")
    key = "mem_light_mb" if light else ("mem_model_mb" if model else "mem_plain_mb")
    adv = "Quit the browser, the game client and other apps; or use --lite / --light-stack."
    judge_low("memory", mem_available_mb(), *THRESHOLDS[key], "MB available", adv)
    sw = swap_used_mb(); w, f = THRESHOLDS["swap_mb"]
    if sw is None: add("WARN", "swap", "could not be measured")
    elif sw > f: add("FAIL", "swap", "%.0f MB of swap in use: the Mac is already memory-starved. Restart heavy apps (or reboot) first." % sw)
    elif sw > w: add("WARN", "swap", "%.0f MB of swap in use; start will be slow. Close apps first." % sw)
    else: add("OK", "swap", "%.0f MB in use" % sw)
    l1 = load_avg()[0]; n = cpus(); w, f = THRESHOLDS["load_per_cpu"]
    if l1 > f * n: add("FAIL", "cpu load", "load %.1f on %d cpus: something heavy is running. Wait or stop it (see: ps -Ao pcpu,comm -r | head)." % (l1, n))
    elif l1 > w * n: add("WARN", "cpu load", "load %.1f on %d cpus is high; the start will wait between stages." % (l1, n))
    else: add("OK", "cpu load", "load %.1f on %d cpus" % (l1, n))
    bp = build_processes()
    if bp: add("FAIL", "compilers", "%s running. A build starves the game of CPU. Wait for it to finish (or stop it)." % ", ".join(bp))
    else: add("OK", "compilers", "no cargo/rustc running")
    for port, what in sorted(PORTS.items()):
        mine = alive(os.path.join(P, "pids/nemo")) if port == NEMO_PORT else alive(os.path.join(P, "pids/veloren"))
        if listening(port) and not mine:
            add("WARN" if force_ports else "FAIL", "port %d" % port, "%s port is already in use by something else (an older test stack? try dev/dev.sh stop). Find it: lsof -nP -iTCP:%d -sTCP:LISTEN" % (what, port))
        else:
            add("OK", "port %d" % port, "free" if not listening(port) else "in use by this stack")
    for rel, what in (("bin/veloren-server-cli", "game server program"), ("bin/nemo-bridge", "resident program"), ("secrets/event.key", "event key")):
        if not os.path.exists(os.path.join(P, rel)):
            add("FAIL", "files", "%s missing (%s). Run: play/play.sh setup" % (rel, what))
    if not any(r[1] == "files" for r in results):
        add("OK", "files", "programs and event key present")
    try:
        mode = oct(os.stat(os.path.join(P, "secrets")).st_mode & 0o777)
        if mode != "0o700": add("WARN", "secrets", "play/secrets has mode %s, expected 700 (ops/hygiene.sh fixes it)" % mode)
    except OSError:
        pass
    for lvl, name, msg in results:
        print("%-4s  %-10s %s" % (lvl, name, msg))
    if any(r[0] == "FAIL" for r in results): return 2
    if any(r[0] == "WARN" for r in results): return 3
    return 0


# ---- watch and soak ------------------------------------------------------------------------------

def error_lines_since(state):
    """Count new error lines in the logs since the last call. `state` maps path -> byte offset (persisted by the caller)."""
    new, last = 0, ""
    logs = ["server.log", "nemo.log"] + ["resident-%s.log" % i for i in CORE] + ["relay-%s.log" % i for i in CORE]
    logs += ["resident-%s.log" % i for i in expected_village()]
    for name in logs:
        path = os.path.join(P, "logs", name)
        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        off = state.get(path, size)          # first look: history is not news
        if off > size: off = 0            # rotated or truncated
        if size > off:
            with open(path, "rb") as f:
                f.seek(off)
                chunk = ANSI.sub("", f.read(min(size - off, 2_000_000)).decode("utf-8", "replace"))
            for line in chunk.splitlines():
                if re.search(r"panicked|\bERROR\b|\bFATAL\b|Error:|ECONNREFUSED|out of memory", line):
                    new += 1; last = (name + ": " + line.strip())[:160]
        state[path] = size
    return new, last


def state_file():
    return os.path.join(os.environ.get("TMPDIR", "/tmp"), "harr-watch-%s.json" % hashlib.sha1(P.encode()).hexdigest()[:10])


def watch_line():
    sf = state_file()
    try: state = json.load(open(sf))
    except (OSError, ValueError): state = {}
    s = status()
    new, last = error_lines_since(state)
    try: json.dump(state, open(sf, "w"))
    except OSError: pass
    p, sysf, w = s["processes"], s["system"], s["works"]
    line = "%s  %-8s load %.1f/%d  mem %sMB  swap %sMB  nemo:%s veloren:%s relays %d/%d res %d/%d vil %d/%d" % (
        time.strftime("%H:%M:%S"), s["overall"], sysf["load1"], sysf["cpus"], sysf["mem_available_mb"], sysf["swap_used_mb"],
        "up" if p["nemo"] else "DOWN", "up" if p["veloren"] else "DOWN", p["relays"]["up"], p["relays"]["expected"],
        p["residents"]["up"], p["residents"]["expected"], p["villagers"]["up"], p["villagers"]["expected"])
    if w: line += "  works %d built/%d crew-wait/clock %dm" % (w["stages_built"], w["waiting_for_crew"], w["clock_minutes"])
    line += "  errors +%d" % new
    if new and last: line += "\n          last: " + last
    print(line)


SAMPLE_COLUMNS = ["time", "elapsed_s", "load1", "load5", "mem_available_mb", "swap_used_mb", "disk_free_gb", "server_procs", "bridge_procs", "node_procs", "cargo_procs", "server_rss_mb", "bridge_rss_mb", "node_rss_mb", "harr_health_ok", "new_errors"]


def sample(args):
    if "--header" in args:
        print(",".join(SAMPLE_COLUMNS)); return
    start = float(os.environ.get("HARR_SOAK_START", time.time()))
    rows = ps_rows()
    def grp(sub, exclude=None):
        sel = [(r, a) for _p, r, a in rows if sub in a and not (exclude and exclude in a)]
        return len(sel), round(sum(r for r, _ in sel) / 1024)
    sv, svr = grp("veloren-server-cli")
    br, brr = grp("nemo-bridge")
    nd = [(r, a) for _p, r, a in rows if re.search(r"(^|/)node\b", a.split(None, 1)[0]) and ("veloren-relay" in a or "start-nemo" in a or "server.js" in a)]
    sf = state_file() + ".soak"
    try: state = json.load(open(sf))
    except (OSError, ValueError): state = {}
    new, _ = error_lines_since(state)
    try: json.dump(state, open(sf, "w"))
    except OSError: pass
    code, body = http_json(NEMO + "/api/v1/veloren/harr/health")
    code2, _ = http_json(NEMO + "/api/v1/health")
    ok = 1 if (code == 200 or (code == 404 and code2 == 200)) else 0   # old servers have no /harr/health: fall back to /health
    l1, l5, _ = load_avg()
    r = lambda v, n=1: "" if v is None else round(v, n)
    row = [time.strftime("%Y-%m-%dT%H:%M:%S"), round(time.time() - start), r(l1, 2), r(l5, 2), r(mem_available_mb(), 0), r(swap_used_mb(), 0), r(disk_free_gb(), 1),
           sv, br, len(nd), len(build_processes(rows)), svr, brr, round(sum(x for x, _ in nd) / 1024), ok, new]
    print(",".join(str(x) for x in row))


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "status"
    rest = argv[2:]
    if cmd == "preflight": return preflight(rest)
    if cmd == "status":
        s = status()
        print(json.dumps(s, indent=2) if "--json" in rest else human_status(s))
        return 0 if s["overall"] in ("ok", "stopped") else 1
    if cmd == "watch-line": watch_line(); return 0
    if cmd == "sample": sample(rest); return 0
    if cmd == "system": print(json.dumps(system_facts(), indent=2)); return 0
    print(__doc__); return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
