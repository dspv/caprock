# How to build the corpus

> **Instructions for the agent.** The human dropped a spec in `docs/` and asked you to build the `.ai/` corpus from it. This file tells you how. Delete it once the corpus exists.

## What you are producing

A `.ai/` corpus that becomes the **source of truth** for this project — replacing the spec, not summarizing it. When you are done, the spec is an archived source and the corpus is what everyone reads.

You are not reformatting a document. You are turning a spec into a structure that answers "where do I look for X" for every X, and that makes it obvious what is decided, what is assumed, and what is unknown.

## Steps

1. **Read the source spec completely** before writing anything. Also read any design mockups, notes, or attachments the human left alongside it.
2. **Read every file in `.ai/`** — they are skeletons with instructions inside. The instructions tell you what belongs in each.
3. **Build the corpus.** Fill the five fixed files; add project-specific files in the free slots (see Numbering).
4. **Archive the source.** Move it to `docs/`, add a banner at the top marking it as not the source of truth.
5. **Run `make docs-fmt`**, then `make docs-check`.
6. **Verify every internal link resolves.** A corpus that cross-links is only useful if the links work.
7. **Update `README.md`** with the project's real content and progress bars matching `14-build-status.md`.
8. **Delete this file.**

## Numbering

**Five files are fixed.** They mean the same thing in every project that uses this system, so an agent arriving cold always knows where to look:

| File                 | Always contains                                    |
| -------------------- | -------------------------------------------------- |
| `00-index.md`        | The map, current state, rules of engagement        |
| `01-product.md`      | What it is, what it promises, what is out of scope |
| `08-decisions.md`    | The ADR log                                        |
| `12-risks.md`        | Risks, the assumption register, open questions     |
| `14-build-status.md` | Progress by track, milestones, the running log     |

**Everything else is yours.** Typical slots, by convention rather than rule:

- `02`–`07` — architecture, the core mechanism, data model, money, surfaces, safety
- `09`–`11` — execution plan, infrastructure, metrics
- `13`, `15`, `16` — legal, secrets, design system

**Leave a slot empty rather than repurposing it.** A project without payments has no `05`. A gap is fine; `08` meaning something different in two repos is not.

## The rules that matter most

These are what make the corpus useful rather than decorative. Follow them literally.

### Never invent a number

If the spec does not state a price, a cost, a conversion rate, or a deadline, **it is an open question** — `OQ-nn` in `12-risks.md` — not a plausible guess.

This is the rule most likely to be violated by accident, because inventing a reasonable-looking figure feels helpful. It is not. A placeholder number is indistinguishable from a real one three weeks later, and decisions get made on it. Where the spec gives a target rather than a measurement, **say which it is** — "target, unmeasured" is a fact; a bare number is a claim.

### One fact, one home

Cross-link with a relative link instead of restating. If a fact genuinely must appear twice, one file owns it and the other links to it.

Duplicated facts do not stay in sync. The second copy is where the wrongness lives.

### Closed debates become ADRs

Any decision the spec settled — or that you had to make while building the corpus — goes in `08-decisions.md`, with:

- **What was decided**
- **What it rules out** — the alternatives that are now off the table
- **What would justify revisiting it**

Write the ADR especially when a decision looks obvious, because an obvious decision with unrecorded reasoning is the one that gets quietly reversed.

**Record decisions you made yourself, clearly marked.** If the spec was silent and you chose, that is an ADR the human needs to see and can overrule.

### Assumptions carry what falsifies them

Every assumption in `12-risks.md` names what would prove it wrong. "We assume users will pay $10" is a belief. "We assume users will pay $10; falsified by cold conversion under 2%" is a testable claim with a trigger attached.

### Say what is not built

`14-build-status.md` is honest or it is worthless. Percentages are coarse on purpose — started, half-built, done. Nothing finer is knowable and finer numbers invite fiction.

### Tables are for short values

If a cell needs a full sentence, use a bulleted list with a bold lead-in per item instead. Then run `make docs-fmt` — **never align by hand.**

### Absolute dates

`2026-08-12`, never "last week" or "recently". A corpus is read months later by someone who does not know when it was written.

## Voice

Write for an agent or a new engineer arriving cold with no context and no access to the person who wrote the spec.

- **State the reasoning, not just the rule.** "Cost comes from usage rows only" is a rule someone will work around. The same rule plus "because an estimate produces plausible numbers forever with no error and no log line" is one they will defend.
- **Be specific about failure.** Name what breaks, not that something might.
- **No filler.** No "it is important to note", no restating the heading in the first sentence.
- **English everywhere**, regardless of the spec's language.

## Definition of done

- Every claim in the corpus traces to the spec, to a marked assumption, or to an ADR you wrote.
- **No number appears that was not in the spec or explicitly marked as a target.**
- `make docs-check` passes.
- Every internal link resolves.
- The source spec is archived in `docs/` with a banner.
- `README.md` progress bars match `14-build-status.md`.
- This file is deleted.
