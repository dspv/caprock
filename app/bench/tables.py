#!/usr/bin/env python3
"""tables.py <spike-data-dir>: the SPIKE.md tables from the raw JSON.
p50/p95 pool every keystroke of both runs; other columns are medians of runs."""
import glob, json, os, statistics as st, sys

R = sys.argv[1]
runs = {}
for f in sorted(glob.glob(f"{R}/tauri-*-r[0-9].json") + glob.glob(f"{R}/web-*-r[0-9].json")):
    name = os.path.basename(f)[:-5]
    client, lps, _ = name.rsplit("-", 2)
    runs.setdefault((client, int(lps)), []).append(json.load(open(f)))

def pooled(ds, p):
    v = sorted(x for d in ds for x in d.get("paint_ms", []))
    return v[min(len(v) - 1, round((len(v) - 1) * p))] if v else None

def med(ds, k):
    v = [d[k] for d in ds if isinstance(d.get(k), (int, float))]
    return st.median(v) if v else None

def fmt(x, n=1):
    return "–" if x is None else f"{x:.{n}f}"

def tab_cpu(d):  # Chrome: renderer + GPU only, i.e. one more tab
    by = d.get("by_type") or {}
    return sum(v["cpu_pct"] for k, v in by.items() if k in ("renderer", "gpu-process")), sum(v["rss_mb"] for k, v in by.items() if k in ("renderer", "gpu-process"))

print("| client | lps | n | timeouts | p50 | p95 | max | socket p50 | first echo (median) | cold start (median) | CPU % | RSS MB end | grid |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for (c, l), ds in sorted(runs.items(), key=lambda x: (x[0][0], x[0][1])):
    if c.endswith("idle"):
        continue
    first = med(ds, "nav_to_first_echo_paint_ms") or med(ds, "pane_to_first_echo_paint_ms")
    mx = max((max(d.get("paint_ms") or [0]) for d in ds), default=None)
    print(f"| {c} | {l} | {sum(d.get('n', 0) for d in ds)} | {sum(d.get('timeouts', 0) for d in ds)} | {fmt(pooled(ds, .5))} | {fmt(pooled(ds, .95))} | {fmt(mx)} | {fmt(med(ds, 'socket_p50_ms'))} | {fmt(first, 0)} | {fmt(med(ds, 'launch_to_first_echo_paint_ms'), 0)} | {fmt(med(ds, 'watch_cpu_pct'))} | {fmt(med(ds, 'rss_mb_end'), 0)} | {ds[0].get('cols')}x{ds[0].get('rows')} |")

print()
for (c, l), ds in sorted(runs.items()):
    if c.startswith("web"):
        t = [tab_cpu(d) for d in ds]
        print(f"chrome tab-only {c} {l}: cpu {st.median(x[0] for x in t):.1f}% rss {[round(x[1]) for x in t]}")
    if c == "tauri-term":
        w = [x for d in ds for x in d.get("warm_open_to_first_echo_paint_ms") or []]
        print(f"warm open {c} {l}: {sorted(round(x) for x in w)}")
    rs = [d.get("rss_mb_end") for d in ds if d.get("rss_mb_end") is not None]
    print(f"rss range {c} {l}: {rs}  launch: {[round(d['launch_to_first_echo_paint_ms']) for d in ds if d.get('launch_to_first_echo_paint_ms')]}")

# Cold start of the dashboard window: launch → the page's load event.
for (c, l), ds in sorted(runs.items()):
    if c != "tauri-dash":
        continue
    v = []
    for d in ds:
        ev = d.get("page_events", [])
        ready = next((e for e in ev if e.get("kind") == "ready"), None)
        first = next((e for e in ev if e.get("kind") == "first"), None)
        if ready and first and d.get("launch_to_first_echo_paint_ms"):
            v.append(round(ready["at"] - (first["paint"] - d["launch_to_first_echo_paint_ms"])))
    print(f"dashboard launch→load {l}: {v}")
