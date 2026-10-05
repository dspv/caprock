#!/usr/bin/env python3
"""procs.py <root-pid> [seconds] [path-prefix]
CPU% and RSS of every process an app owns: the root, its descendants, and every
process macOS counts as "responsible" to it (WebKit's XPC helpers — WebContent,
GPU, Networking — are launchd children, not app children, but Activity Monitor
charges them to the app through the same responsibility API used here).
CPU% is CPU time delta over the window / wall time (100% = one core)."""
import ctypes, json, subprocess, sys, time

lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
try:
    rpid = lib.responsibility_get_pid_responsible_for_pid
    rpid.argtypes = [ctypes.c_int]; rpid.restype = ctypes.c_int
except AttributeError:
    rpid = None

def table():
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,time=,rss=,comm="], capture_output=True, text=True).stdout
    rows = {}
    for l in out.splitlines():
        p = l.split(None, 4)
        if len(p) < 5: continue
        pid, ppid, t, rss, comm = int(p[0]), int(p[1]), p[2], int(p[3]), p[4]
        parts = [float(x) for x in t.replace("-", ":").split(":")]
        sec = 0.0
        for x in parts: sec = sec * 60 + x
        rows[pid] = dict(ppid=ppid, cpu=sec, rss=rss, comm=comm)
    return rows

def family(root, rows):
    fam = {root} if root in rows else set()
    changed = True
    while changed:
        changed = False
        for pid, r in rows.items():
            if pid in fam: continue
            if r["ppid"] in fam or (rpid and rpid(pid) in fam):
                fam.add(pid); changed = True
    return fam

def sample(root):
    rows = table(); fam = family(root, rows)
    keep = {p: rows[p] for p in fam}
    if PREFIX:
        # app-only: the bundle's own executables and WebKit's helpers, not what
        # the app's terminals launched (shells, claude, ...)
        keep = {p: r for p, r in keep.items() if p == root or r["comm"].startswith(PREFIX) or "com.apple.WebKit" in r["comm"]}
    return keep

def measure(root, seconds):
    a = sample(root); t0 = time.time(); peak = sum(r["rss"] for r in a.values())
    end = t0 + seconds
    while time.time() < end:
        time.sleep(min(1, max(0, end - time.time())))
        s = sample(root); peak = max(peak, sum(r["rss"] for r in s.values()))
    b = sample(root); wall = time.time() - t0
    procs = []
    for p, r in b.items():
        procs.append(dict(pid=p, comm=r["comm"].split("/")[-1], rss_mb=round(r["rss"] / 1024, 1),
                          cpu_pct=round((r["cpu"] - a.get(p, {"cpu": r["cpu"]})["cpu"]) / wall * 100, 1)))
    procs.sort(key=lambda x: -x["rss_mb"])
    return dict(seconds=round(wall, 1), processes=len(procs),
                cpu_pct=round(sum(x["cpu_pct"] for x in procs), 1),
                rss_mb_end=round(sum(x["rss_mb"] for x in procs), 1), rss_mb_peak=round(peak / 1024, 1), by_process=procs)

PREFIX = None
if __name__ == "__main__":
    PREFIX = sys.argv[3] if len(sys.argv) > 3 else None
    r = measure(int(sys.argv[1]), float(sys.argv[2]) if len(sys.argv) > 2 else 20)
    print(json.dumps(r, indent=2))
