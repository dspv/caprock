#!/usr/bin/env python3
"""report.py <results-dir>
The budget table of .ai/21-app.md § Budgets from the raw JSON in a results
directory: app-r*.json (app.mjs), phone-r*.json (phone.mjs), size.json
(run-macos.sh). One column per run; the verdict is "pass" only when every run
meets the budget, "fail" when none does, "mixed" otherwise. Prints Markdown."""
import glob, json, os, sys

R = sys.argv[1]


def load(pattern):
    out = []
    for f in sorted(glob.glob(os.path.join(R, pattern))):
        try:
            out.append((os.path.basename(f)[:-5], json.load(open(f))))
        except ValueError:
            print(f"skipping unreadable {f}", file=sys.stderr)
    return out


apps = load("app-r*.json")
phones = load("phone-r*.json")
size = json.load(open(os.path.join(R, "size.json"))) if os.path.exists(os.path.join(R, "size.json")) else {}


def get(d, *path):
    for p in path:
        if isinstance(d, dict) and p in d:
            d = d[p]
        elif isinstance(d, list) and isinstance(p, int) and p < len(d):
            d = d[p]
        else:
            return None
    return d


def worst_echo(d, key):
    cells = get(d, "phases", "echo", "cells") or {}
    v = [c.get(key) for c in cells.values() if isinstance(c.get(key), (int, float))]
    return max(v) if v else None


def max_lag(d):
    v = []
    for ph in (d.get("phases") or {}).values():
        if not isinstance(ph, dict):
            continue
        for lag in [ph.get("lag")] + [c.get("lag") for c in (ph.get("cells") or {}).values()] + [m.get("lag") for m in (ph.get("memory") or {}).values() if isinstance(m, dict)]:
            if isinstance(lag, dict) and isinstance(lag.get("max_gap_ms"), (int, float)):
                v.append(lag["max_gap_ms"])
    return max(v) if v else None


def mem(d, n, key="rss_mb_peak"):
    """RSS, the spike's figure, at its peak over the 10 s window."""
    return get(d, "phases", "open_tabs", "memory", n, key)


def disk_per_day(d):
    idle = get(d, "phases", "cpu_visible", "no_output")
    if not idle or not idle.get("seconds"):
        return None
    return idle["disk_written_mb"] / idle["seconds"] * 86400


# (metric, budget text, limit, unit, extractor, source)
ROWS = [
    ("Echo p50, any load to 1000 lines/s", "≤ 12 ms", 12, "ms", lambda d: worst_echo(d, "p50"), apps),
    ("Echo p95, any load to 1000 lines/s", "≤ 25 ms", 25, "ms", lambda d: worst_echo(d, "p95"), apps),
    ("Echo p95 in tab A while tab B floods", "≤ 25 ms", 25, "ms", lambda d: get(d, "phases", "flood_isolation", "p95"), apps),
    ("Open a session, click to first echo, p50", "≤ 200 ms", 200, "ms", lambda d: get(d, "phases", "open_tabs", "p50"), apps),
    ("Switch to an open tab, to first paint", "≤ 50 ms", 50, "ms", lambda d: get(d, "phases", "switch_tabs", "p50"), apps),
    ("Cold start to interactive window", "≤ 1.5 s", 1500, "ms", lambda d: get(d, "phases", "cold_start", "interactive_p50"), apps),
    ("Cold start to first echo in a restored tab", "≤ 2.5 s", 2500, "ms", lambda d: get(d, "phases", "cold_start", "restored_echo_p50"), apps),
    ("Memory, all app processes, 1 tab", "≤ 250 MB", 250, "MB", lambda d: mem(d, "1"), apps),
    ("Memory, all app processes, 10 tabs", "≤ 450 MB", 450, "MB", lambda d: mem(d, "10"), apps),
    ("CPU, window visible, no output", "≤ 1% of one core", 1, "%", lambda d: get(d, "phases", "cpu_visible", "no_output", "cpu_pct"), apps),
    ("CPU, window hidden", "≤ 0.2% of one core", 0.2, "%", lambda d: get(d, "phases", "cpu_hidden", "no_output", "cpu_pct"), apps),
    ("CPU, one visible tab at 1000 lines/s", "≤ 25% of one core", 25, "%", lambda d: get(d, "phases", "cpu_visible", "one_tab_1000_lps", "cpu_pct"), apps),
    ("UI long task during the benchmark", "none over 100 ms", 100, "ms (longest stall)", max_lag, apps),
    ("Daemon restart to live terminal", "≤ 2 s", 2000, "ms", lambda d: get(d, "phases", "daemon_restart", "daemon_up_to_live_terminal_ms"), apps),
    ("Network back to live terminal (phone)", "≤ 3 s median", 3000, "ms", lambda d: get(d, "phases", "reconnect", "back_to_live_p50"), phones),
    ("Half-open connection detected", "≤ 25 s", 25000, "ms", lambda d: max(get(d, "phases", "reconnect", "half_open_detected_ms") or [None], key=lambda x: -1 if x is None else x), phones),
    ("Disk written by the app, per day", "≤ 10 MB", 10, "MB (idle rate × 24 h)", disk_per_day, apps),
]


def fmt(v, unit):
    if v is None:
        return "–"
    if unit.startswith("ms") and v >= 1000:
        return f"{v / 1000:.2f} s"
    if isinstance(v, float):
        return f"{v:.1f} {unit.split(' ')[0]}" if v >= 1 or unit != "%" else f"{v:.2f} %"
    return f"{v} {unit.split(' ')[0]}"


def verdict(values, limit):
    v = [x for x in values if isinstance(x, (int, float))]
    if not v:
        return "not measured"
    ok = [x <= limit for x in v]
    if len(v) < len(values):
        return "fail (a run failed)" if not any(ok) else "mixed (a run failed)"
    return "pass" if all(ok) else "fail" if not any(ok) else "mixed"


runs = max(len(apps), len(phones), 1)
m = (apps or phones or [(None, {})])[0][1].get("machine", {})
if m:
    print(f"# Benchmarks, {m.get('date', '')[:10]}")
    print()
    print(f"{m.get('model', '')} ({m.get('chip') or m.get('cpu_model')}, {m.get('cpus')} cores, {m.get('mem_gb')} GB), "
          f"{m.get('os')}, display {m.get('displays', '–')}, {m.get('power', '')}. Runs started "
          + ", ".join(d.get("machine", {}).get("date", "")[:16].replace("T", " ") + " UTC" for _, d in apps) + ".")
    print()
head = "| Metric | Budget | " + " | ".join(f"run {i + 1}" for i in range(runs)) + " | Verdict |"
print(head)
print("|" + "---|" * (runs + 3))
for name, text, limit, unit, fn, src in ROWS:
    values = [fn(d) for _, d in src]
    cells = [fmt(x, unit) for x in values] + ["–"] * (runs - len(values))
    print(f"| {name} | {text} | " + " | ".join(cells) + f" | {verdict(values, limit) if src else 'not measured'} |")
dmg = size.get("release_dmg_mb") or size.get("dmg_mb")
cells = [fmt(dmg, "MB")] + ["–"] * (runs - 1)
print(f"| Download size, per OS ({size.get('download_note', 'macOS')}) | ≤ 60 MB | " + " | ".join(cells) + f" | {verdict([dmg], 60) if dmg else 'not measured'} |")

print()
print("Also measured (no budget row):")
print()
for name, d in apps:
    print(f"- {name}: memory (RSS peak) 5 tabs {fmt(mem(d, '5'), 'MB')}, 10 tabs after 40 s {fmt(mem(d, '10_settled'), 'MB')};"
          f" physical footprint 1/5/10 tabs {fmt(mem(d, '1', 'footprint_mb_end'), 'MB')} / {fmt(mem(d, '5', 'footprint_mb_end'), 'MB')} / {fmt(mem(d, '10', 'footprint_mb_end'), 'MB')};"
          f" open p95 {fmt(get(d, 'phases', 'open_tabs', 'p95'), 'ms')}; switch p95 {fmt(get(d, 'phases', 'switch_tabs', 'p95'), 'ms')};"
          f" CPU spinner only (visible) {fmt(get(d, 'phases', 'cpu_visible', 'spinner_only', 'cpu_pct'), '%')},"
          f" hidden with spinners {fmt(get(d, 'phases', 'cpu_hidden', 'spinners_running', 'cpu_pct'), '%')};"
          f" disk in the first two minutes {fmt(get(d, 'phases', 'long_session_disk', 'first_two_minutes', 'disk_written_total_mb'), 'MB')};"
          f" first launch of a new copy {fmt(get(d, 'phases', 'cold_start_first', 'interactive_ms'), 'ms')}")
    cells = get(d, "phases", "echo", "cells") or {}
    for rate, c in sorted(cells.items(), key=lambda x: int(x[0])):
        print(f"  - echo at {rate} lines/s: p50 {fmt(c.get('p50'), 'ms')}, p95 {fmt(c.get('p95'), 'ms')}, max {fmt(c.get('max'), 'ms')}, socket p50 {fmt(c.get('socket_p50'), 'ms')}, n {c.get('n')}, timeouts {c.get('timeouts')}, input {c.get('key_path')}")
for name, d in phones:
    for prof, c in (get(d, "phases", "chat_open") or {}).items():
        if isinstance(c, dict) and "p50" in c:
            print(f"- {name}: chat open on {prof}: p50 {fmt(c.get('p50'), 'ms')}, p95 {fmt(c.get('p95'), 'ms')} ({c.get('runs')})")
    rc = get(d, "phases", "reconnect") or {}
    if rc.get("runs"):
        print(f"- {name}: back to live p95 {fmt(rc.get('back_to_live_p95'), 'ms')}, max {fmt(rc.get('back_to_live_max'), 'ms')}, failed {rc.get('failed')}")
        for r in rc["runs"]:
            print(f"  - {r['kind']} ({r['down_ms'] / 1000:.0f} s): {fmt(r['back_to_live_ms'], 'ms')}" + (f", detected after {fmt(r.get('half_open_detected_ms'), 'ms')}, redialled after {fmt(r.get('half_open_redial_ms'), 'ms')}" if r['kind'] == 'half_open' else ""))
print()
for name, d in apps + phones:
    loads = [ph.get("load_before", {}).get("load") for ph in (d.get("phases") or {}).values() if isinstance(ph, dict)]
    loads = [l[0] for l in loads if l]
    if loads:
        print(f"- {name}: 1-minute load average before each phase {min(loads):.1f}–{max(loads):.1f} on {d['machine'].get('cpus')} cores")
