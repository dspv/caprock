# [Project] — Context for AI Agents

<!-- SKELETON. Replace every bracketed placeholder. Delete these comments as you go.
     This is the agent's entry point. Keep it short — it is read on every task, and a
     long file here gets skimmed, which defeats the purpose. -->

## What this is

[One paragraph: what the project is, how it works, who it is for.]

**Status: [phase].** [What exists right now, in one sentence.] See `.ai/14-build-status.md`.

## Repository structure

- `.ai/` — full documentation, **source of truth**. Read before any task.
- `scripts/align-tables.py` — markdown table tight-aligner (see Tables below).
- `docs/` — human-facing docs and the archived source spec.

## How to get context

Read `.ai/00-index.md` first. Then read the file for your task:

<!-- A routing table, not a description of the corpus. Left column is what the agent is
     about to do; right column is what to read first. -->

| Working on...                      | Read...                  |
| ---------------------------------- | ------------------------ |
| Anything (always)                  | `.ai/01-product.md`      |
| Why a decision was made            | `.ai/08-decisions.md`    |
| Risks, assumptions, open questions | `.ai/12-risks.md`        |
| Current progress                   | `.ai/14-build-status.md` |

## Non-negotiable rules

<!-- Numbered, each with its reason. A rule without a reason gets worked around by
     someone who thinks they understand the intent better than the author did.
     Rules 1-3 apply to any project using this system; add yours around them. -->

1. **[The rule that outranks everything — usually about scope or shipping order.]**

2. **All code, commits, PR titles, descriptions and docs in English.** Conventional Commits.

3. **No invented numbers anywhere public** — prices, costs, margins, performance claims. Measured, not estimated. A figure you do not have is an open question, not a plausible guess.

4. **[Project-specific rules. State the failure each one prevents.]**

5. **Keep the docs current as you build.** A change to behaviour lands with its documentation change in the same commit — including `.ai/14-build-status.md` and the README progress bars.

## Dev commands

```bash
make help        # list targets
make docs-fmt    # tight-align all markdown tables (run after editing any table)
make docs-check  # fail if any table is unaligned (CI runs this)
```

## Tables

All markdown tables must be tight-aligned (each column padded to its longest value, separator exactly that width, no trailing whitespace). **Never align manually** — run after editing:

```bash
make docs-fmt
```

**Tables are for short enumerable values only.** If a cell needs a full sentence or more, do not use a table — rewrite it as a bulleted list with a bold lead-in per item. Wide prose-in-cells tables are unreadable in diffs and terminals.
