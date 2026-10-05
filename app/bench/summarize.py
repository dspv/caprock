import json, glob, os, sys, statistics as st
# summarize.py <results-dir> [round]
# Files are <client>-<lines-per-second>-r<round>.json from Bench.swift / web.mjs.
# p50/p95/max pool every keystroke of every run; the other columns are medians across runs.
R = sys.argv[1]
rnd = sys.argv[2] if len(sys.argv) > 2 else "*"
rows = {}
for f in sorted(glob.glob(f"{R}/*-r{rnd}.json")):
    name = os.path.basename(f)[:-5]
    try:
        d = json.load(open(f))
    except Exception as e:
        print("bad", name, e); continue
    client, lps = name.rsplit("-", 2)[0], name.rsplit("-", 2)[1]
    rows.setdefault((client, int(lps)), []).append(d)
def med(ds, k):
    v = [d.get(k) for d in ds if isinstance(d.get(k), (int, float))]
    return round(st.median(v), 1) if v else None
def pooled(ds, p, key="paint_ms"):
    v = sorted(x for d in ds for x in d.get(key, []))
    return round(v[min(len(v) - 1, round((len(v) - 1) * p))], 1) if v else None
def tab(ds, key):
    v = []
    for d in ds:
        by = d.get("by_type")
        if not by: return None
        v.append(sum(x[key] for k, x in by.items() if k in ("renderer", "gpu-process")))
    return round(st.median(v), 1) if v else None
print(f"{'client':14} {'lps':>5} {'runs':>4} {'n':>4} {'to':>3} {'p50':>6} {'p95':>6} {'max':>6} {'sock50':>6} {'first':>7} {'launch':>7} {'cpu%':>6} {'rss':>5} {'tabcpu':>6} {'tabrss':>6} vis grid")
for (c, l), ds in sorted(rows.items(), key=lambda x: (x[0][1], x[0][0])):
    n = sum(d.get("n", 0) for d in ds)
    to = sum(d.get("timeouts", 0) for d in ds)
    first = med(ds, "nav_to_first_echo_paint_ms") or med(ds, "pane_to_first_echo_paint_ms")
    launch = med(ds, "launch_to_first_echo_paint_ms")
    v = sorted(x for d in ds for x in d.get("paint_ms", []))
    mx = round(v[-1], 1) if v else None
    vis = all(d.get("visible", d.get("visibility") == "visible") for d in ds)
    print(f"{c:14} {l:>5} {len(ds):>4} {n:>4} {to:>3} {pooled(ds,.5)!s:>6} {pooled(ds,.95)!s:>6} {mx!s:>6} {med(ds,'socket_p50_ms')!s:>6} {first!s:>7} {launch!s:>7} {med(ds,'watch_cpu_pct')!s:>6} {med(ds,'rss_mb_end')!s:>5} {tab(ds,'cpu_pct')!s:>6} {tab(ds,'rss_mb')!s:>6} {vis!s:>3} {ds[0].get('cols')}x{ds[0].get('rows')}")
