#!/usr/bin/env python3
"""Check (or dump) the branded window of a mounted Caprock .dmg.

    python dmg_window.py check <mount point> <tauri.conf.json>
    python dmg_window.py dump  <mount point>

Finder draws a .dmg's window from the .DS_Store at the volume's root: the
window's bounds and chrome (`bwsp`), the icon view with its background
picture (`icvp`, the picture as an alias to a file on the volume) and each
icon's position (`Iloc`). Without that file the window opens as a bare white
folder, which is how every CI-built .dmg shipped until 2026-11-02 (Tauri's
bundler skips its Finder step when CI=true). `check` reads the file with the
ds_store library and fails unless it carries the layout bundle.macOS.dmg in
the config asks for, and the picture it names is the one in the repository.

Run it with the interpreter scripts/app-dmg.sh sets up (`app-dmg.sh check`),
which has ds_store and mac_alias installed. `problems()` itself takes plain
values, so the tests run without either library.
"""

import hashlib
import json
import os
import plistlib
import re
import sys

BOUNDS = re.compile(r"\{\{\s*(-?\d+),\s*(-?\d+)\s*\},\s*\{\s*(\d+),\s*(\d+)\s*\}\}")


def parse_bounds(text):
    """`{{x, y}, {w, h}}` -> (x, y, w, h), or None."""
    m = BOUNDS.fullmatch(text.strip()) if isinstance(text, str) else None
    return tuple(int(g) for g in m.groups()) if m else None


def problems(window, conf, app_name, files):
    """What is wrong with a window against the config; empty when it is right.

    window: {"bwsp": dict, "icvp": dict, "background": path on the volume the
             picture's alias names (or None), "iloc": {name: (x, y)}}
    conf:   bundle.macOS.dmg from tauri.conf.json
    files:  {"background": sha256 of the picture on the volume (None when
             missing), "expected_background": sha256 of the repository's}
    """
    out = []
    bwsp = window.get("bwsp") or {}
    icvp = window.get("icvp") or {}
    if not bwsp:
        out.append("no window settings (bwsp) in .DS_Store")
    else:
        b = parse_bounds(bwsp.get("WindowBounds"))
        want = (conf["windowSize"]["width"], conf["windowSize"]["height"])
        if b is None:
            out.append(f"window bounds unreadable: {bwsp.get('WindowBounds')!r}")
        elif b[2:] != want:
            out.append(f"window is {b[2]}x{b[3]}, the config says {want[0]}x{want[1]}")
        for key in ("ShowToolbar", "ShowStatusBar"):
            if bwsp.get(key, True):
                out.append(f"{key} is not off")
    if not icvp:
        out.append("no icon view settings (icvp) in .DS_Store")
    else:
        if icvp.get("backgroundType") != 2:
            out.append(f"background type is {icvp.get('backgroundType')}, not a picture (2)")
        if float(icvp.get("iconSize", 0)) != 128:
            out.append(f"icon size is {icvp.get('iconSize')}, not 128")
    if conf.get("background"):
        if not window.get("background"):
            out.append("the background alias names no file")
        elif files.get("background") is None:
            out.append(f"the background alias names {window['background']}, which is not on the volume")
        elif files["background"] != files.get("expected_background"):
            out.append(f"{window['background']} is not {conf['background']}")
    iloc = window.get("iloc") or {}
    for name, key in ((app_name, "appPosition"), ("Applications", "applicationFolderPosition")):
        want = (conf[key]["x"], conf[key]["y"])
        got = iloc.get(name)
        if got is None:
            out.append(f"no position for {name}")
        elif tuple(got) != want:
            out.append(f"{name} is at {tuple(got)}, the config says {want}")
    return out


def read_window(mount):
    """The window settings in <mount>/.DS_Store as plain values."""
    from ds_store import DSStore  # noqa: PLC0415 (installed by app-dmg.sh)
    from mac_alias import Alias  # noqa: PLC0415

    path = os.path.join(mount, ".DS_Store")
    window = {"bwsp": {}, "icvp": {}, "background": None, "iloc": {}}
    with DSStore.open(path, "r") as d:
        for entry in d:
            if entry.filename == "." and entry.code in (b"bwsp", b"icvp"):
                v = entry.value
                if isinstance(v, tuple):  # ('blob', bytes)
                    v = v[1]
                if isinstance(v, bytes):
                    v = plistlib.loads(v)
                window[entry.code.decode()] = v
            elif entry.code == b"Iloc":
                window["iloc"][entry.filename] = tuple(entry.value)
    raw = window["icvp"].get("backgroundImageAlias")
    if raw:
        target = Alias.from_bytes(raw).target
        # The alias records the picture's path from the volume's root.
        rel = (target.posix_path or "").lstrip("/") or target.filename
        window["background"] = rel
    return window


def sha256(path):
    try:
        with open(path, "rb") as fp:
            return hashlib.sha256(fp.read()).hexdigest()
    except OSError:
        return None


def main(argv):
    if len(argv) < 2 or argv[0] not in ("check", "dump"):
        print(__doc__, file=sys.stderr)
        return 2
    mount = argv[1]
    if not os.path.isfile(os.path.join(mount, ".DS_Store")):
        print(f"dmg window: no .DS_Store in {mount}: the window would open unstyled", file=sys.stderr)
        return 1
    window = read_window(mount)
    if argv[0] == "dump":
        icvp = dict(window["icvp"])
        if "backgroundImageAlias" in icvp:
            icvp["backgroundImageAlias"] = f"<alias, {len(icvp['backgroundImageAlias'])} bytes>"
        print(json.dumps({**window, "icvp": icvp}, indent=2, sort_keys=True, default=str))
        return 0
    conf_path = argv[2]
    with open(conf_path, encoding="utf-8") as fp:
        dmg = json.load(fp)["bundle"]["macOS"]["dmg"]
    src_tauri = os.path.dirname(os.path.abspath(conf_path))
    files = {
        "background": sha256(os.path.join(mount, window["background"])) if window["background"] else None,
        "expected_background": sha256(os.path.join(src_tauri, dmg["background"])) if dmg.get("background") else None,
    }
    found = problems(window, dmg, "Caprock.app", files)
    for p in found:
        print(f"dmg window: {p}", file=sys.stderr)
    if found:
        return 1
    b = parse_bounds(window["bwsp"]["WindowBounds"])
    print(
        f"  ok: .DS_Store window {b[2]}x{b[3]}, background {window['background']}, "
        + ", ".join(f"{k} at {v}" for k, v in sorted(window["iloc"].items()))
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
