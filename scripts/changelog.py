#!/usr/bin/env python3
"""One file per change, assembled into CHANGELOG.md at release.

Every pull request used to edit CHANGELOG.md's `## [Unreleased]` section, and
with eight or ten of them in flight git did worse than conflict: a release PR
shifted the context lines, and three later entries were merged silently into
sections that had already shipped (2026-10-15). Now a pull request adds one
file, `changes/unreleased/<slug>.md`, and nothing else touches CHANGELOG.md
until a release assembles them. The format is in changes/README.md:

    ---
    kind: Fixed
    ---
    - **scope:** what changed, for a person reading the release notes.

Usage:
    changelog.py check                   # validate every fragment (make docs-check)
    changelog.py preview                 # print the next release's section
    changelog.py assemble X.Y.Z YYYY-MM-DD   # write it into CHANGELOG.md, delete the fragments

Order: kinds in Keep a Changelog order; within a kind, fragments in the order
git first added them (oldest first), then any not yet committed, each tie
broken by file name. Never by mtime, which a checkout rewrites.
"""
import datetime
import os
import re
import subprocess
import sys

KINDS = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]
FRAGMENTS = os.path.join("changes", "unreleased")
CHANGELOG = "CHANGELOG.md"
CYRILLIC = re.compile("[Ѐ-ӿԀ-ԯᲀ-᲏ⷠ-ⷿꙀ-ꚟ]")
VERSION = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")


class FragmentError(Exception):
    pass


def parse(text, name="fragment"):
    """Return (kind, body) for one fragment's text, or raise FragmentError."""
    lines = text.replace("\r\n", "\n").split("\n")
    if not lines or lines[0].strip() != "---":
        raise FragmentError(f"{name}: must start with a '---' line")
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration:
        raise FragmentError(f"{name}: front matter has no closing '---' line") from None
    kind = None
    for line in lines[1:end]:
        if not line.strip():
            continue
        key, sep, value = line.partition(":")
        if not sep or key.strip() != "kind":
            raise FragmentError(f"{name}: front matter holds only 'kind: <{'|'.join(KINDS)}>', got {line.strip()!r}")
        kind = value.strip()
    if kind is None:
        raise FragmentError(f"{name}: front matter has no 'kind:' line")
    if kind not in KINDS:
        raise FragmentError(f"{name}: kind {kind!r} is not one of {', '.join(KINDS)}")
    body = "\n".join(lines[end + 1:]).strip("\n")
    body = "\n".join(line.rstrip() for line in body.split("\n"))
    if not body.strip():
        raise FragmentError(f"{name}: has no entry under the front matter")
    if not body.startswith("- **"):
        raise FragmentError(f"{name}: the entry must start with '- **scope:**'")
    for line in body.split("\n"):
        if line.startswith("#"):
            raise FragmentError(f"{name}: no headings in an entry; the kind picks its section")
    if CYRILLIC.search(text):
        raise FragmentError(f"{name}: holds Cyrillic; the repository is English only (CLAUDE.md rule 5)")
    return kind, body


def fragment_paths(root):
    d = os.path.join(root, FRAGMENTS)
    if not os.path.isdir(d):
        return []
    return sorted(
        os.path.join(FRAGMENTS, n).replace(os.sep, "/")
        for n in os.listdir(d)
        if n.endswith(".md") and not n.startswith(".")
    )


def added_order(root):
    """Map each fragment path git knows to its rank, oldest addition first."""
    try:
        out = subprocess.run(
            ["git", "-C", root, "log", "--reverse", "--no-renames", "--diff-filter=A",
             "--name-only", "--format=", "--", FRAGMENTS],
            check=True, capture_output=True, text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return {}
    # A slug reused after an earlier release was added twice; the newest
    # addition is the one waiting now, so a later line overwrites an earlier.
    rank = {}
    for i, line in enumerate(out.splitlines()):
        p = line.strip()
        if p:
            rank[p] = i
    return rank


def load(root):
    """Return [(path, kind, body)] in assembly order; raise on the first bad fragment."""
    paths = fragment_paths(root)
    rank = added_order(root) if paths else {}
    last = max(rank.values(), default=0) + 1
    paths.sort(key=lambda p: (rank.get(p, last), p))
    out = []
    for p in paths:
        with open(os.path.join(root, p), encoding="utf-8") as f:
            kind, body = parse(f.read(), p)
        out.append((p, kind, body))
    return out


def render(entries):
    """The grouped body of a release section, without its `## ` heading."""
    parts = []
    for kind in KINDS:
        bodies = [b for _, k, b in entries if k == kind]
        if bodies:
            parts.append(f"### {kind}\n\n" + "\n".join(bodies) + "\n")
    return "\n".join(parts)


def insert(changelog, section):
    """Put a whole `## [...]` section after the [Unreleased] one."""
    lines = changelog.split("\n")
    start = next((i for i, l in enumerate(lines) if l.lower().startswith("## [unreleased]")), None)
    if start is None:
        raise FragmentError(f"{CHANGELOG} has no '## [Unreleased]' section")
    nxt = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    head = "\n".join(lines[:nxt]).rstrip("\n")
    tail = "\n".join(lines[nxt:])
    return head + "\n\n" + section.rstrip("\n") + "\n\n" + tail


def cmd_check(root):
    paths = fragment_paths(root)
    bad = []
    for p in paths:
        try:
            with open(os.path.join(root, p), encoding="utf-8") as f:
                parse(f.read(), p)
        except (FragmentError, UnicodeDecodeError) as e:
            bad.append(str(e))
    d = os.path.join(root, FRAGMENTS)
    if os.path.isdir(d):
        for n in sorted(os.listdir(d)):
            if not n.endswith(".md") and not n.startswith("."):
                bad.append(f"{FRAGMENTS}/{n}: a fragment is a .md file")
    for b in bad:
        print(f"changelog: {b}", file=sys.stderr)
    if bad:
        print("changelog: the format is in changes/README.md", file=sys.stderr)
        return 1
    return 0


def cmd_preview(root):
    entries = load(root)
    if not entries:
        print("(no unreleased changes)")
        return 0
    print(f"## [next] - (unreleased, {len(entries)} change{'s' if len(entries) != 1 else ''})\n")
    print(render(entries), end="")
    return 0


def cmd_assemble(root, version, date):
    version = version.lstrip("vV")
    if not VERSION.match(version):
        raise FragmentError(f"version {version!r} is not X.Y.Z")
    try:
        datetime.date.fromisoformat(date)
    except ValueError:
        raise FragmentError(f"date {date!r} is not YYYY-MM-DD") from None
    entries = load(root)
    if not entries:
        raise FragmentError(f"no fragments in {FRAGMENTS}/: nothing to release")
    path = os.path.join(root, CHANGELOG)
    with open(path, encoding="utf-8", newline="") as f:
        text = f.read()
    if re.search(r"^## \[" + re.escape(version) + r"\]", text, re.MULTILINE):
        raise FragmentError(f"{CHANGELOG} already has a [{version}] section")
    section = f"## [{version}] - {date}\n\n" + render(entries)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(insert(text, section))
    for p, _, _ in entries:
        os.remove(os.path.join(root, p))
    print(f"changelog: {len(entries)} fragment(s) assembled into [{version}] - {date}")
    return 0


def main(argv):
    root = os.environ.get("CHANGELOG_ROOT") or os.getcwd()
    if len(argv) == 1 and argv[0] == "check":
        return cmd_check(root)
    try:
        if len(argv) == 1 and argv[0] == "preview":
            return cmd_preview(root)
        if len(argv) == 3 and argv[0] == "assemble":
            return cmd_assemble(root, argv[1], argv[2])
    except FragmentError as e:
        print(f"changelog: {e}", file=sys.stderr)
        return 1
    print(__doc__.split("Usage:")[1].split("Order:")[0].rstrip(), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
