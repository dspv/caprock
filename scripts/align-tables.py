#!/usr/bin/env python3
"""
align-tables.py — tight-align all markdown tables in the given files.

Per AGENTS.md § Markdown table alignment:
- Every column is padded to the width of the longest value in that column.
- The separator `---...` is exactly that width.
- No trailing whitespace after the last column.
- Stray "spacer" rows (cells containing only dashes / colons / whitespace)
  that appear between the separator and the first data row are removed.
- Tables inside fenced code blocks are left alone.

Usage:
  python3 scripts/align-tables.py <file> [<file> ...]   # rewrite in place
  python3 scripts/align-tables.py --check <file> ...    # exit 1 if unaligned

`make docs-fmt` runs the first form over all docs; `make docs-check` runs the
second and is what CI enforces.
"""

import re
import sys
from pathlib import Path


SPACER_CELL = re.compile(r"^[-: ]+$")


def is_table_line(line: str) -> bool:
    stripped = line.strip()
    return stripped.startswith("|") and stripped.endswith("|")


def parse_row(line: str) -> list[str]:
    inner = line.strip()[1:-1]
    return [cell.strip() for cell in inner.split("|")]


def is_separator_row(cells: list[str]) -> bool:
    return all(SPACER_CELL.match(c) for c in cells) and len(cells) > 0


def is_blank_row(cells: list[str]) -> bool:
    return all(c == "" for c in cells)


def align_table(rows: list[list[str]]) -> list[str]:
    if len(rows) < 2:
        return [" | ".join(rows[0])] if rows else []

    header = rows[0]
    separator = rows[1]
    ncols = len(header)

    data: list[list[str]] = []
    for r in rows[2:]:
        if is_separator_row(r) or is_blank_row(r):
            continue
        padded = list(r) + [""] * (ncols - len(r)) if len(r) < ncols else r[:ncols]
        data.append(padded)

    widths = [len(c) for c in header]
    for row in data:
        for j, cell in enumerate(row):
            if len(cell) > widths[j]:
                widths[j] = len(cell)

    out: list[str] = []
    out.append("| " + " | ".join(header[j].ljust(widths[j]) for j in range(ncols)) + " |")
    out.append("| " + " | ".join("-" * widths[j] for j in range(ncols)) + " |")
    for row in data:
        out.append("| " + " | ".join(row[j].ljust(widths[j]) for j in range(ncols)) + " |")
    return out


def process_file(path: Path, check_only: bool = False) -> bool:
    text = path.read_text(encoding="utf-8")
    lines = text.split("\n")

    out_lines: list[str] = []
    i = 0
    changed = False

    in_code = False
    while i < len(lines):
        line = lines[i]

        if line.strip().startswith("```"):
            in_code = not in_code
            out_lines.append(line)
            i += 1
            continue

        if in_code or not is_table_line(line):
            out_lines.append(line)
            i += 1
            continue

        j = i
        while j < len(lines) and is_table_line(lines[j]):
            j += 1

        block = [parse_row(lines[k]) for k in range(i, j)]
        if len(block) >= 2 and is_separator_row(block[1]):
            aligned = align_table(block)
            out_lines.extend(aligned)
            if aligned != [lines[k] for k in range(i, j)]:
                changed = True
        else:
            out_lines.extend(lines[i:j])

        i = j

    if changed and not check_only:
        path.write_text("\n".join(out_lines), encoding="utf-8")
    return changed


def main() -> int:
    args = [a for a in sys.argv[1:] if a != "--check"]
    check_only = "--check" in sys.argv

    if not args:
        print(
            "Usage: align-tables.py [--check] <file> [<file> ...]", file=sys.stderr
        )
        return 2

    touched = 0
    for arg in args:
        p = Path(arg)
        if not p.exists():
            print(f"skip (missing): {p}", file=sys.stderr)
            continue
        if process_file(p, check_only=check_only):
            touched += 1
            print(f"{'UNALIGNED' if check_only else 'aligned'}: {p}")

    if check_only:
        if touched:
            print(
                f"{touched} file(s) have unaligned tables — "
                f"run `make docs-fmt`",
                file=sys.stderr,
            )
            return 1
        print("all tables aligned")
        return 0

    print(f"{touched} file(s) changed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
