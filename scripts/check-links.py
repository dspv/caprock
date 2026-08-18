#!/usr/bin/env python3
"""
check-links.py — verify that every relative markdown link resolves.

A corpus is held together by cross-links: "one fact, one home" only works if the
link to that home is not broken. A dead link sends a reader to invent the fact
locally, which is how a corpus starts contradicting itself.

Checked:
- Relative links: [text](other-file.md), [text](../dir/file.md#anchor)
- Relative image paths.

Ignored:
- Absolute URLs (http://, https://, mailto:, etc.)
- Pure anchors ([text](#section)) — anchor targets are not resolved.
- Links inside fenced code blocks.
- Bracketed placeholders like [text]([01-...]) left in an unfilled skeleton.

Usage:
  python3 scripts/check-links.py <file> [<file> ...]   # exit 1 on any broken link

`make docs-links` runs this over all docs; `make check` includes it.
"""

import re
import sys
from pathlib import Path

LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)]+)\)|!\[[^\]]*\]\(([^)]+)\)")
FENCE = re.compile(r"^\s*(```|~~~)")
SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")


def is_placeholder(target: str) -> bool:
    """Unfilled skeleton links like ([01-...]) or ([source-spec].md)."""
    return target.startswith("[") or "..." in target


def targets(text: str):
    """Yield (line_number, target) for links outside fenced code blocks."""
    in_fence = False
    for lineno, line in enumerate(text.splitlines(), 1):
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for match in LINK.finditer(line):
            target = match.group(1) or match.group(2)
            if target:
                yield lineno, target.strip()


def broken(path: Path) -> list[str]:
    out = []
    for lineno, target in targets(path.read_text(encoding="utf-8")):
        if target.startswith("#") or SCHEME.match(target) or is_placeholder(target):
            continue
        # Strip an anchor; the file must exist, the anchor is not resolved.
        file_part = target.split("#", 1)[0]
        if not file_part:
            continue
        if not (path.parent / file_part).exists():
            out.append(f"{path}:{lineno}: {target}")
    return out


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: check-links.py <file> [<file> ...]", file=sys.stderr)
        return 2

    failures = []
    for arg in argv:
        p = Path(arg)
        if p.is_file():
            failures.extend(broken(p))

    if failures:
        print("broken links:")
        for f in failures:
            print(f"  {f}")
        return 1

    print("all links resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
