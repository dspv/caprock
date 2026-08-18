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
- Nothing else: anchors ARE resolved. `file.md#anchor` and `#anchor` must match a
  heading in the target file, using GitHub's slug rules (lowercase, spaces → `-`,
  punctuation dropped, duplicate slugs suffixed `-1`, `-2`, …).
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


HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
INLINE_CODE = re.compile(r"`([^`]*)`")
MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_slug_cache: dict[Path, set[str]] = {}


def github_slug(title: str) -> str:
    """Approximate GitHub's heading → anchor algorithm."""
    t = MD_LINK.sub(r"\1", title)          # keep link text, drop target
    t = INLINE_CODE.sub(r"\1", t)         # drop backticks, keep code text
    t = t.strip().lower()
    t = re.sub(r"[^\w\- ]", "", t)         # drop punctuation (unicode word chars kept)
    t = t.replace(" ", "-")
    return t


def anchors_of(path: Path) -> set[str]:
    if path in _slug_cache:
        return _slug_cache[path]
    seen: dict[str, int] = {}
    slugs: set[str] = set()
    in_fence = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = HEADING.match(line)
        if not m:
            continue
        base = github_slug(m.group(2))
        n = seen.get(base, 0)
        seen[base] = n + 1
        slugs.add(base if n == 0 else f"{base}-{n}")
    _slug_cache[path] = slugs
    return slugs


def broken(path: Path) -> list[str]:
    out = []
    for lineno, target in targets(path.read_text(encoding="utf-8")):
        if SCHEME.match(target) or is_placeholder(target):
            continue
        file_part, _, anchor = target.partition("#")
        dest = path if not file_part else (path.parent / file_part)
        if not dest.exists():
            out.append(f"{path}:{lineno}: {target}")
            continue
        if anchor and dest.suffix == ".md" and anchor not in anchors_of(dest):
            out.append(f"{path}:{lineno}: {target}  (no such heading)")
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
