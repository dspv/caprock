#!/usr/bin/env python3
"""Write latest.json, the desktop app's update manifest (F20, ADR-041).

The app's updater (tauri-plugin-updater) reads

    https://github.com/dspv/caprock/releases/latest/download/latest.json

and installs the bundle it names for its platform only if the bundle's
minisign signature verifies against the public key built into the app. This
script builds that file from the signatures the release jobs attached: each
updater bundle has a `<file>.sig` beside it, and the signature itself (the
.sig file's contents) goes into the manifest.

    scripts/app-update-manifest.py vX.Y.Z DIR [--repo dspv/caprock] [--date ISO]

DIR holds the release's `*.sig` files. Platforms whose bundle is missing are
left out, and the app says "no signed update for this platform yet" rather
than installing anything. With no signature at all it writes nothing and
exits 3, so the caller can tell "unsigned release" from a failure.

| Bundle                              | Platforms                     |
| ----------------------------------- | ----------------------------- |
| Caprock_<v>_universal.app.tar.gz    | darwin-aarch64, darwin-x86_64 |
| Caprock_<v>_x64-setup.exe           | windows-x86_64                |
| Caprock_<v>_amd64.AppImage          | linux-x86_64-appimage         |

Linux is keyed by bundle type on purpose: a .deb or .rpm install looks up
`linux-x86_64-deb` / `-rpm`, then `linux-x86_64`, finds neither, and is told
to use its package manager.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys

NO_SIGNATURES = 3


def bundles(version: str) -> list[tuple[str, list[str]]]:
    return [
        (f"Caprock_{version}_universal.app.tar.gz", ["darwin-aarch64", "darwin-x86_64"]),
        (f"Caprock_{version}_x64-setup.exe", ["windows-x86_64"]),
        (f"Caprock_{version}_amd64.AppImage", ["linux-x86_64-appimage"]),
    ]


def manifest(tag: str, sigdir: str, repo: str, date: str) -> dict | None:
    if not re.fullmatch(r"v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?", tag):
        raise ValueError(f"{tag} is not vX.Y.Z")
    version = tag[1:]
    platforms: dict[str, dict[str, str]] = {}
    for name, keys in bundles(version):
        path = os.path.join(sigdir, name + ".sig")
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as f:
            signature = f.read().strip()
        if not signature:
            raise ValueError(f"{name}.sig is empty")
        url = f"https://github.com/{repo}/releases/download/{tag}/{name}"
        for key in keys:
            platforms[key] = {"signature": signature, "url": url}
    if not platforms:
        return None
    return {
        "version": version,
        "notes": f"https://github.com/{repo}/releases/tag/{tag}",
        "pub_date": date,
        "platforms": dict(sorted(platforms.items())),
    }


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("tag")
    ap.add_argument("sigdir")
    ap.add_argument("--repo", default="dspv/caprock")
    ap.add_argument("--date", default=None, help="RFC 3339; defaults to now, UTC")
    ap.add_argument("--out", default="-")
    a = ap.parse_args(argv)
    date = a.date or dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    try:
        m = manifest(a.tag, a.sigdir, a.repo, date)
    except ValueError as e:
        print(f"app-update-manifest: {e}", file=sys.stderr)
        return 2
    if m is None:
        print(f"app-update-manifest: no updater signatures for {a.tag} in {a.sigdir}", file=sys.stderr)
        return NO_SIGNATURES
    text = json.dumps(m, indent=2) + "\n"
    if a.out == "-":
        sys.stdout.write(text)
    else:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text)
    print(f"app-update-manifest: {', '.join(m['platforms'])}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
