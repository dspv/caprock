# Changelog fragments

A pull request does not edit `CHANGELOG.md`. It adds one file to
`changes/unreleased/` holding its entry, and the release assembles those files
into the next version's section.

Why: with eight or ten pull requests in flight, every one of them edited the
`## [Unreleased]` section. Git conflicted on them, and worse, when a release
pull request shifted the context lines it merged later entries silently into
sections that had already shipped — three times on 2026-10-15. Separate files
never touch the same lines.

## The file

Name it after the pull request or its branch: `changes/unreleased/652-changelog-fragments.md`,
or `changes/unreleased/changelog-fragments.md` before the PR has a number. The
name only has to be unique; it is never shown.

```markdown
---
kind: Fixed
---
- **scope:** what changed, written for a person reading the release notes.
  Continuation lines are indented two spaces, as in CHANGELOG.md.
```

- **Front matter:** a `---` line, `kind: <Kind>`, a `---` line, and nothing
  else. The kind is one of `Added`, `Changed`, `Deprecated`, `Removed`,
  `Fixed`, `Security`; it picks the `### ` section the entry lands under.
- **Entry:** starts with `- **scope:**`, the same scope as the commit. One
  bullet is usual; several are allowed when they share a kind. A change with
  entries of two kinds is two files. No headings.
- **English only** (CLAUDE.md rule 5): `make docs-check` rejects Cyrillic here
  as `make lang-check` does everywhere else.

`make docs-check` runs `scripts/changelog.py check` on every fragment.

## At release

```bash
python3 scripts/changelog.py preview                     # the next section, printed
python3 scripts/changelog.py assemble X.Y.Z YYYY-MM-DD   # written into CHANGELOG.md
```

`assemble` adds `## [X.Y.Z] - YYYY-MM-DD` under `## [Unreleased]`, with the
entries grouped by kind in Keep a Changelog order. Within a kind they come in
the order git first added the files, oldest first (uncommitted ones last, ties
by file name), never by modification time. It then deletes the fragments it
used; commit both together in the release pull request.
