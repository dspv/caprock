#!/usr/bin/env python3
"""measure.py <app-pid> <label> <out.jsonl> [--vmmap DIR]
One sample of the app's memory: every process macOS charges to the app
(bench/procs.py's family), and for WebContent, GPU and the shell the
`footprint -j` categories grouped. Appends one JSON line; prints a summary."""
import json, os, subprocess, sys, tempfile, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import procs  # noqa: E402

GROUPS = [
    ("graphics", lambda c: "graphics" in c or c in ("IOSurface", "IOAccelerator", "CG Raster Data", "CoreAnimation", "CG image", "Image IO")),
    ("webkit_malloc", lambda c: c.startswith("WebKit Malloc")),
    ("malloc", lambda c: c.startswith("Malloc")),
    ("js", lambda c: c.startswith("JS ") or "JavaScript" in c),
    ("wasm", lambda c: c.startswith("WebAssembly")),
]


def group(cats):
    out = {g: 0 for g, _ in GROUPS}
    out["other"] = 0
    raw = {}
    for name, v in cats.items():
        d = v.get("dirty", 0)
        raw[name] = d
        for g, f in GROUPS:
            if f(name):
                out[g] += d
                break
        else:
            out["other"] += d
    mb = lambda b: round(b / 2**20, 1)
    top = sorted(raw.items(), key=lambda kv: -kv[1])[:8]
    return {k: mb(v) for k, v in out.items()}, [(k, mb(v)) for k, v in top]


def main():
    pid, label, out = int(sys.argv[1]), sys.argv[2], sys.argv[3]
    vm = sys.argv[sys.argv.index("--vmmap") + 1] if "--vmmap" in sys.argv else None
    rows = procs.table()
    fam = procs.family(pid, rows)
    names = {p: rows[p]["comm"].split("/")[-1] for p in fam}
    keep = [p for p in fam if "WebKit" in names[p] or p == pid]
    # One process per call: with several pids, the unmapped graphics
    # footprint is not listed among a process's categories.
    fp = {"processes": []}
    for p in keep:
        tmp = tempfile.mktemp(suffix=".json")
        subprocess.run(["footprint", "-j", tmp, str(p)], capture_output=True)
        try:
            fp["processes"] += json.load(open(tmp)).get("processes", [])
            os.unlink(tmp)
        except (OSError, ValueError):
            pass
    rec = {"at": time.strftime("%H:%M:%S"), "label": label, "procs": {}}
    total = 0
    for p in fam:
        f, _ = procs.rusage(p)
        total += f or 0
    rec["family_footprint_mb"] = round(total / 2**20, 1)
    for p in fp.get("processes", []):
        g, top = group(p["categories"])
        rec["procs"][f'{p["name"].replace("com.apple.WebKit.", "")}:{p["pid"]}'] = {
            "footprint_mb": round(p["footprint"] / 2**20, 1),
            "peak_mb": round(p["auxiliary"].get("phys_footprint_peak", 0) / 2**20, 1),
            "groups": g, "top": top}
        if vm and ("WebContent" in p["name"] or "GPU" in p["name"]):
            r = subprocess.run(["vmmap", "--summary", str(p["pid"])], capture_output=True, text=True)
            safe = label.replace(" ", "_").replace("/", "-")
            open(os.path.join(vm, f"{safe}-{p['pid']}.txt"), "w").write(r.stdout)
    with open(out, "a") as fh:
        fh.write(json.dumps(rec) + "\n")
    line = [f"{label:28s} family {rec['family_footprint_mb']:7.1f}"]
    for k, v in rec["procs"].items():
        g = v["groups"]
        line.append(f"{k} {v['footprint_mb']:.0f} (gfx {g['graphics']:.0f} wk {g['webkit_malloc']:.0f} mal {g['malloc']:.0f} js {g['js']:.0f} oth {g['other']:.0f})")
    print(" | ".join(line))


main()
