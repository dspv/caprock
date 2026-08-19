# Caprock — Agent Onboarding

> **CRITICAL — read this first.**
> `CLAUDE.md` (repo root) and `.ai/00-index.md` are the authoritative instructions for this project. They define the non-negotiable rules. Everything in this file is supplementary. **If there is any conflict, `CLAUDE.md` wins.**

Caprock is a local, open-source mission control for Claude Code — a single Go binary that watches every `claude` session on the machine (hooks + transcripts), shows live activity/cost/loop alerts in a browser dashboard, and spawns, controls, and orchestrates sessions with verification-before-done. Currently **all three phases (Observe, Control, Orchestrate) complete and green on the 3-OS CI matrix; v0.1.0–v0.5.0 tagged + published through 2026-08-20** (v0.4.0 = post-Orchestrate polish: plan-limit windows, orchestrator-lifecycle fixes, Homebrew formula).

## Start here

1. Read **`CLAUDE.md`** — the non-negotiable rules (Claude Code auto-loads it).
2. Read **`.ai/00-index.md`** — current state + the doc map (file → when to read it).
3. Read the **one** file the map names for your task. Don't read the whole corpus.
4. Contributing code? **`CONTRIBUTING.md`** — build, test (`make check`), PR flow.

## Documentation map

The full doc map (every file → when to read it) lives in
[`.ai/00-index.md`](.ai/00-index.md) — the one home for it. Read the one file
your task needs, not the whole corpus. To contribute code, see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Markdown table alignment

All tables in the repo's markdown must have columns padded to the exact width of the longest value per column.

### Rule

1. Columns must be **tight**: the separator `---...` is exactly the width of the longest value in that column.
2. **No trailing whitespace** after the last column.
3. **Use the script — do not align manually.**
4. **Tables are for short enumerable values only.** If any cell needs a full sentence or more, do not use a table — rewrite as a bulleted list (one bold lead-in per item, sub-bullets for facets). Wide prose-in-cells tables are unreadable in diffs and terminals.
5. Tables inside fenced code blocks are left alone by the script.

```bash
make docs-fmt                             # rewrite in place
make docs-check                           # exit 1 if anything is unaligned (CI)
python3 scripts/align-tables.py .ai/*.md  # the script directly
```

## Keeping documentation current

The docs are the source of truth, so they go stale the moment code moves without them. Rules:

- **A behaviour change lands with its documentation change in the same commit.** Not a follow-up commit, not a cleanup pass.
- **`.ai/14-build-status.md` and `README.md` progress bars are updated together** — they carry the same numbers.
- **A closed debate becomes an ADR** in `.ai/08-decisions.md`, with its reasoning. Prose scattered across files is not a decision record.
- **One fact, one home.** Cross-link rather than restate. If a fact must appear twice, one file owns it and the other links.
- **Absolute dates.** "2026-08-18", never "last week".

## Key rules (summary — full versions in CLAUDE.md)

- Phase order is the product: Observe → Control → Orchestrate.
- No task is done with a red Windows CI job.
- The shim never breaks a user's Claude session; all data stays on the machine.
- English everywhere in code/commits/PRs; Conventional Commits.
- No invented numbers — a figure you do not have is an open question, not a guess.
- Never signal or type into a process Caprock did not start.
