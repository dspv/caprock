#!/usr/bin/env python3
"""
check-no-cyrillic.py — fail if any tracked text file contains Cyrillic.

The repository is English only (CLAUDE.md rule 5). Test input that needs
multi-byte text uses Greek, Japanese, accented Latin or emoji instead.

Skipped: internal/api/dist/** (generated; third-party fonts and libraries) and
binary files (a NUL byte, or not valid UTF-8).

Usage:
  python3 scripts/check-no-cyrillic.py   # exit 1 and list file:line on any hit

`make lang-check` runs this; `make check` and the docs CI job include it.
"""

import re
import subprocess
import sys

CYRILLIC = re.compile("[\u0400-\u04ff\u0500-\u052f\u1c80-\u1c8f\u2de0-\u2dff\ua640-\ua69f]")
SKIP_PREFIXES = ("internal/api/dist/",)


def tracked_files() -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z"], check=True, capture_output=True).stdout
    return [p for p in out.decode().split("\0") if p and not p.startswith(SKIP_PREFIXES)]


def read_text(path: str) -> str | None:
    try:
        data = open(path, "rb").read()
    except OSError:
        return None  # deleted in the working tree, a submodule, etc.
    if b"\0" in data:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def main() -> int:
    hits = []
    for path in tracked_files():
        text = read_text(path)
        if text is None or not CYRILLIC.search(text):
            continue
        for n, line in enumerate(text.splitlines(), 1):
            if CYRILLIC.search(line):
                hits.append(f"{path}:{n}: {line.strip()[:120]}")
    if hits:
        print("Cyrillic text found (the repository is English only, CLAUDE.md rule 5):")
        print("\n".join(hits))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
