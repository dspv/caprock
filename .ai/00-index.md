# [Project] — AI Agent Context

<!-- SKELETON. Replace every bracketed placeholder. Delete these comments as you go.
     This file is the map. An agent reads it first and decides what else to read. -->

Read this file first. Then read the task-specific file below.

<!-- One paragraph: what this project is, who it is for, how it works, what makes it
     unusual. Dense, no marketing. An agent should be able to reason about the project
     from this paragraph alone. -->

[What this project is, in one paragraph.]

| File                                     | Contents               | Read when...                   |
| ---------------------------------------- | ---------------------- | ------------------------------ |
| [01-product.md](01-product.md)           | [What it is, promises] | Always                         |
| [08-decisions.md](08-decisions.md)       | [ADR log]              | Before revisiting any decision |
| [12-risks.md](12-risks.md)               | [Risks, assumptions]   | Before expanding scope         |
| [14-build-status.md](14-build-status.md) | [What is built]        | Checking progress              |

<!-- Add a row per project-specific file. The "Read when" column is what makes this
     table useful — it is a routing rule, not a description. -->

These files absorb the original specification (`docs/[source-spec].md`). The spec is not a separate source of truth — **these files are**. If a fact appears in both, these win.

Supporting directories:

| Path       | Contents                                    |
| ---------- | ------------------------------------------- |
| `scripts/` | `align-tables.py` — the table tight-aligner |
| `docs/`    | [Human-facing docs, the archived spec]      |

## Current State

**Last updated: [YYYY-MM-DD]** · Owner: [name] · Phase: **[phase]**

<!-- The honest present tense. What exists, what does not, what is unverified.
     This is the section most likely to go stale and most damaging when it does. -->

- **[What is actually built — or "Nothing is built yet."]**
- **[What is still unknown or unmeasured, with its OQ/ASSUMPTION id.]**

## Rules of engagement — non-negotiable

<!-- 5-12 rules. Each states the rule AND why, because a rule without a reason gets
     worked around. Order them by how expensive it is to break them.
     Below are the four that apply to any project using this system — keep them,
     add your own project-specific rules around them. -->

1. **[Project-specific rule that outranks everything — usually about scope or shipping order.]**
2. **All code, commits, PR titles, descriptions and docs in English.** Conventional Commits.
3. **No invented numbers anywhere public.** Prices, costs, margins, and performance claims come from measurement. A figure you do not have is an open question, not a plausible guess.
4. **[Add rules specific to this project. State the failure each one prevents.]**

## Documentation rules

- **Tables must be tight-aligned.** Never align by hand — run `make docs-fmt` after editing any file with a table.
- **Tables are for short enumerable values only.** If a cell needs a full sentence, use a bulleted list instead — prose-in-cells tables are unreadable in diffs and terminals.
- **One fact, one home.** Cross-link with a relative link rather than restating. If a fact must live in two files, one of them is the owner and the other links to it.
- **Decisions go in [08-decisions.md](08-decisions.md), not in prose.** If a debate closes, it becomes an ADR. Check the ADR log before reopening anything.
- **Update [14-build-status.md](14-build-status.md) and § Current State above when the state of the world changes** — dates in absolute form, never "last week".
