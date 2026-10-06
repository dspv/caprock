#!/usr/bin/env python3
"""procs.py <root-pid> [seconds] [path-prefix]
CPU%, memory and disk writes of every process an app owns (macOS): the root,
its descendants, and every process macOS counts as "responsible" to it
(WebKit's XPC helpers — WebContent, GPU, Networking — are launchd children,
not app children, but Activity Monitor charges them to the app through the
same responsibility API used here).
CPU% is CPU time delta over the window / wall time (100% = one core).
rss_mb is resident memory (the spike's figure); footprint_mb is the physical
footprint Activity Monitor shows as "Memory". disk_written_mb is what the
kernel counted as written to disk by these processes over the window
(proc_pid_rusage ri_diskio_byteswritten); disk_written_total_mb since each
process started.

Ported from the Tauri spike (branch spike/tauri-app, app/bench/procs.py);
footprint and disk writes added for WP-16."""
import ctypes, json, subprocess, sys, time

lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
try:
    rpid = lib.responsibility_get_pid_responsible_for_pid
    rpid.argtypes = [ctypes.c_int]; rpid.restype = ctypes.c_int
except AttributeError:
    rpid = None

RUSAGE_INFO_V2 = 2


class RusageInfoV2(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(n, ctypes.c_uint64) for n in (
        "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins", "wired_size",
        "resident_size", "phys_footprint", "proc_start_abstime", "proc_exit_abstime", "child_user_time",
        "child_system_time", "child_pkg_idle_wkups", "child_interrupt_wkups", "child_pageins",
        "child_elapsed_abstime", "diskio_bytesread", "diskio_byteswritten")]


lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.POINTER(RusageInfoV2)]
lib.proc_pid_rusage.restype = ctypes.c_int


def rusage(pid):
    """(phys_footprint bytes, disk bytes written) or (None, None) when not readable."""
    info = RusageInfoV2()
    if lib.proc_pid_rusage(pid, RUSAGE_INFO_V2, ctypes.byref(info)) != 0:
        return None, None
    return info.phys_footprint, info.diskio_byteswritten


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

def sample(root, prefix=None):
    rows = table(); fam = family(root, rows)
    keep = {p: rows[p] for p in fam}
    if prefix:
        # app-only: the bundle's own executables and WebKit's helpers, not what
        # the app's terminals launched (shells, claude, ...)
        keep = {p: r for p, r in keep.items() if p == root or r["comm"].startswith(prefix) or "com.apple.WebKit" in r["comm"]}
    for p, r in keep.items():
        r["footprint"], r["written"] = rusage(p)
    return keep

def measure(root, seconds, prefix=None):
    a = sample(root, prefix); t0 = time.time(); peak = sum(r["rss"] for r in a.values())
    end = t0 + seconds
    while time.time() < end:
        time.sleep(min(1, max(0, end - time.time())))
        s = sample(root, prefix); peak = max(peak, sum(r["rss"] for r in s.values()))
    b = sample(root, prefix); wall = time.time() - t0
    procs = []
    for p, r in b.items():
        before = a.get(p, {"cpu": 0.0, "written": 0})
        procs.append(dict(pid=p, comm=r["comm"].split("/")[-1], rss_mb=round(r["rss"] / 1024, 1),
                          footprint_mb=None if r["footprint"] is None else round(r["footprint"] / 2**20, 1),
                          cpu_pct=round((r["cpu"] - before["cpu"]) / wall * 100, 2),
                          disk_written_mb=None if r["written"] is None else round((r["written"] - (before.get("written") or 0)) / 2**20, 3),
                          disk_written_total_mb=None if r["written"] is None else round(r["written"] / 2**20, 3)))
    procs.sort(key=lambda x: -x["rss_mb"])
    total = lambda k: round(sum(x[k] or 0 for x in procs), 3)
    return dict(seconds=round(wall, 1), processes=len(procs),
                cpu_pct=round(sum(x["cpu_pct"] for x in procs), 2),
                rss_mb_end=round(sum(x["rss_mb"] for x in procs), 1), rss_mb_peak=round(peak / 1024, 1),
                footprint_mb_end=round(total("footprint_mb"), 1),
                disk_written_mb=total("disk_written_mb"), disk_written_total_mb=total("disk_written_total_mb"),
                unreadable=[x["comm"] for x in procs if x["footprint_mb"] is None],
                by_process=procs)

if __name__ == "__main__":
    prefix = sys.argv[3] if len(sys.argv) > 3 else None
    r = measure(int(sys.argv[1]), float(sys.argv[2]) if len(sys.argv) > 2 else 20, prefix)
    print(json.dumps(r, indent=2))
