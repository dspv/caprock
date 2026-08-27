#!/usr/bin/env python3
"""Print CHANGELOG.md's entry for one version, for use as a release body.

The dashboard shows the release body under "what's new" (it arrives with the
version in `GET /v1/update`), and goreleaser's default body is a list of commit
subjects with their hashes — `1c836d5: fix(ui): …`. Nobody reads that. The
changelog already says what changed in prose, aimed at a person, so that is
what should be in front of one.

Usage:
    release-notes.py v0.31.2 [CHANGELOG.md]

Exits non-zero if the version has no section, which is deliberate: a release
whose changelog entry was forgotten should fail loudly at build time rather
than ship an empty "what's new".
"""
import pathlib
import re
import sys


def extract(text: str, version: str) -> str:
    """Return the body of the `## [version]` section, without its heading."""
    v = version.lstrip("vV")
    # Match the heading for this version, then take everything up to the next
    # `## ` heading at the same level.
    pattern = re.compile(
        r"^##\s*\[?" + re.escape(v) + r"\]?[^\n]*\n(.*?)(?=^##\s|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    m = pattern.search(text)
    if not m:
        return ""
    return m.group(1).strip()


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    version = sys.argv[1]
    path = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "CHANGELOG.md")
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        print(f"release-notes: {e}", file=sys.stderr)
        return 1

    body = extract(text, version)
    if not body:
        print(
            f"release-notes: no CHANGELOG section for {version} — "
            f"add one before tagging",
            file=sys.stderr,
        )
        return 1
    print(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
