#!/usr/bin/env python3
"""procs-linux.py <root-pid> [seconds]
Linux counterpart of procs.py (same JSON): CPU%, memory and disk writes of
the app and its descendants. WebKitGTK's WebKitWebProcess and
WebKitNetworkProcess are children of the app here, so the process tree is the
whole app. footprint_mb is PSS (smaps_rollup), the closest to macOS's
physical footprint; disk_written_mb is /proc/<pid>/io write_bytes (reading it
needs the same user). Written for WP-16; not yet run on a Linux machine."""
import json, os, sys, time

TICK = os.sysconf("SC_CLK_TCK")


def read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return None


def table():
    rows = {}
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        stat = read(f"/proc/{d}/stat")
        if not stat:
            continue
        comm = stat[stat.index("(") + 1:stat.rindex(")")]
        f = stat[stat.rindex(")") + 2:].split()
        rows[int(d)] = dict(ppid=int(f[1]), cpu=(int(f[11]) + int(f[12])) / TICK, rss=int(f[21]) * os.sysconf("SC_PAGE_SIZE") // 1024, comm=comm)
    return rows


def family(root, rows):
    fam = {root} if root in rows else set()
    changed = True
    while changed:
        changed = False
        for pid, r in rows.items():
            if pid not in fam and r["ppid"] in fam:
                fam.add(pid); changed = True
    return fam


def extra(pid):
    pss = None
    for line in (read(f"/proc/{pid}/smaps_rollup") or "").splitlines():
        if line.startswith("Pss:"):
            pss = int(line.split()[1]) * 1024
    written = None
    for line in (read(f"/proc/{pid}/io") or "").splitlines():
        if line.startswith("write_bytes:"):
            written = int(line.split()[1])
    return pss, written


def sample(root):
    rows = table()
    keep = {p: rows[p] for p in family(root, rows)}
    for p, r in keep.items():
        r["footprint"], r["written"] = extra(p)
    return keep


def measure(root, seconds):
    a = sample(root); t0 = time.time(); peak = sum(r["rss"] for r in a.values())
    end = t0 + seconds
    while time.time() < end:
        time.sleep(min(1, max(0, end - time.time())))
        peak = max(peak, sum(r["rss"] for r in sample(root).values()))
    b = sample(root); wall = time.time() - t0
    procs = []
    for p, r in b.items():
        before = a.get(p, {"cpu": 0.0, "written": 0})
        procs.append(dict(pid=p, comm=r["comm"], rss_mb=round(r["rss"] / 1024, 1),
                          footprint_mb=None if r["footprint"] is None else round(r["footprint"] / 2**20, 1),
                          cpu_pct=round((r["cpu"] - before["cpu"]) / wall * 100, 2),
                          disk_written_mb=None if r["written"] is None else round((r["written"] - (before.get("written") or 0)) / 2**20, 3),
                          disk_written_total_mb=None if r["written"] is None else round(r["written"] / 2**20, 3)))
    procs.sort(key=lambda x: -x["rss_mb"])
    total = lambda k: round(sum(x[k] or 0 for x in procs), 3)
    return dict(seconds=round(wall, 1), processes=len(procs), cpu_pct=round(sum(x["cpu_pct"] for x in procs), 2),
                rss_mb_end=round(sum(x["rss_mb"] for x in procs), 1), rss_mb_peak=round(peak / 1024, 1),
                footprint_mb_end=round(total("footprint_mb"), 1), disk_written_mb=total("disk_written_mb"),
                disk_written_total_mb=total("disk_written_total_mb"),
                unreadable=[x["comm"] for x in procs if x["footprint_mb"] is None], by_process=procs)


if __name__ == "__main__":
    print(json.dumps(measure(int(sys.argv[1]), float(sys.argv[2]) if len(sys.argv) > 2 else 20), indent=2))
