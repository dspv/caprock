# [Project] — Agent Onboarding

> **CRITICAL — read this first.**
> `CLAUDE.md` (repo root) and `.ai/00-index.md` are the authoritative instructions for this project. They define the non-negotiable rules. Everything in this file is supplementary. **If there is any conflict, `CLAUDE.md` wins.**

<!-- SKELETON. Replace every bracketed placeholder. Delete these comments as you go.
     This file exists for agents that look for AGENTS.md rather than CLAUDE.md.
     It duplicates the entry point deliberately — that is the one accepted exception
     to "one fact, one home", because the two files are read by different tools. -->

[One paragraph: what the project is.] Currently **[phase]** — [what exists].

## Start here

1. Read **`CLAUDE.md`** — non-negotiable rules.
2. Read **`.ai/00-index.md`** — documentation map + current state.
3. Read **`.ai/14-build-status.md`** — what is actually built right now.
4. Then read the file specific to your task (map in `CLAUDE.md`).

## Documentation map

| File                     | Contents                                       |
| ------------------------ | ---------------------------------------------- |
| `.ai/00-index.md`        | Index + current state + rules of engagement    |
| `.ai/01-product.md`      | [What it is and what it promises]              |
| `.ai/08-decisions.md`    | ADR log — check before reopening anything      |
| `.ai/12-risks.md`        | Risks, the assumption register, open questions |
| `.ai/14-build-status.md` | Running build log, progress, next action       |

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
- **Absolute dates.** "2026-08-12", never "last week".

## Key rules (summary — full versions in CLAUDE.md)

- [The project's top rule.]
- English everywhere in code/commits/PRs; Conventional Commits.
- No invented numbers — a figure you do not have is an open question, not a guess.
- [Other project-specific rules.]
