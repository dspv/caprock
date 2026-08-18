# Contributing

Corpus is small on purpose. The most useful contribution is a report from real use: what the structure failed to capture, or what an agent got wrong despite it.

## What is likely to be accepted

- **A failure the system did not prevent.** You used it, something degraded anyway — scattered facts, a silently reversed decision, an invented number that survived review. This is the most valuable thing you can send, and an issue describing it is enough.
- **Skeleton instructions that mislead agents.** If a comment in a skeleton produced a consistently wrong result, that is a bug.
- **Tooling fixes.** Both scripts are pure-python with no dependencies; keep it that way.
- **A missing rule that earned its place**, with the specific failure it prevents.

## What is unlikely to be accepted

- **More files.** Five fixed files is a deliberate ceiling. A sixth needs to be common to most projects, not just yours — project-specific files go in the free slots, which is what they are for.
- **Example data in skeletons.** This is the one hard rule. Realistic-looking placeholder metrics teach agents to produce realistic-looking metrics, which is the failure this system exists to prevent. Placeholders stay bracketed and obviously empty.
- **Renumbering.** Fixed numbers only work if they are fixed. `08` is the ADR log everywhere or the convention is worthless.
- **Tooling dependencies.** A template that needs `npm install` before it can check a table is a template people stop running.
- **Style preferences without a failure attached.** "I prefer X" is not a reason; "X caused Y" is.

## Before opening a PR

```bash
make check   # tables aligned, links resolve — CI runs exactly this
```

Commits and PR text in English, Conventional Commits format.

## Scope

This repo is the template. Documentation *about your project* belongs in your project's corpus, not here.
