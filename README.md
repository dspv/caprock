# Corpus

**A documentation system for projects built with AI agents.** Clone it, drop in your spec, tell the agent to build the corpus.

[![docs](https://github.com/cybrixcc/corpus/actions/workflows/docs.yml/badge.svg)](https://github.com/cybrixcc/corpus/actions/workflows/docs.yml)

---

## The problem

You are building with agents. Every session starts cold, so the project's context has to live in files. That much is obvious, and most people get as far as a `.ai/` folder or a long `CLAUDE.md`.

Then it degrades, in a predictable order:

1. **Facts scatter.** The price is in three files. Two of them are stale, and nobody knows which.
2. **Decisions get re-litigated.** A choice settled in March is quietly reversed in May by an agent that had no idea it was a decision at all.
3. **Plans and reality blur.** The docs describe a system that does not exist yet, in the present tense, and nothing distinguishes "built" from "intended".
4. **Numbers get invented.** An agent needs a conversion rate, does not have one, writes a plausible one. Three weeks later it is indistinguishable from a measurement, and decisions rest on it.

Every one of these is cheap to prevent and expensive to discover. Corpus is the structure that prevents them.

## What it is

A `.ai/` corpus that is the **source of truth** for a project — read by agents before any task, kept current by rule rather than by habit — plus the tooling that keeps it honest.

**Corpus is not a code-standards kit.** It is the layer above:

| Repo                                    | Answers                                                              |
| --------------------------------------- | -------------------------------------------------------------------- |
| [dspv/kit](https://github.com/dspv/kit) | How to write code — English-only, commits, secrets, health checks    |
| **corpus** (this)                       | How to run a project — `.ai/`, ADRs, risks, status, table discipline |

They compose. Use both, or either.

## Quick start

1. **Use this template** (button above) or clone.
2. Drop your spec in as `docs/source-spec.md`. Any format — a napkin sketch, a long build spec, a design mockup.
3. Tell your agent:

> Read `TEMPLATE.md`. Build the `.ai/` corpus from `docs/source-spec.md`.

4. Review what it produced — especially the open questions and the ADRs it wrote itself.
5. `make check` before every commit.

The agent's full instructions are in [`TEMPLATE.md`](TEMPLATE.md), which it deletes when the corpus exists.

## What you get

```
.ai/00-index.md          # The map. Read first, always.
.ai/01-product.md        # What it is and what it promises
.ai/08-decisions.md      # ADR log — closed decisions
.ai/12-risks.md          # Risks, assumptions, open questions
.ai/14-build-status.md   # What is done / not done / next
CLAUDE.md                # Agent entry point + non-negotiable rules
AGENTS.md                # Agent onboarding + doc map
Makefile                 # docs-fmt / docs-check / docs-links / check
scripts/align-tables.py  # Markdown table tight-aligner
scripts/check-links.py   # Relative-link resolver
.github/workflows/       # CI gate on both
```

Each skeleton carries its authoring instructions inside it, as comments the agent deletes as it fills them in.

**Five numbered files are fixed.** Everything between them is yours — a project with payments adds `05-money.md`, one without leaves the slot empty. A gap in the numbering is better than `08` meaning different things in two repos, because the whole value of fixed numbering is that an agent arriving cold knows where the ADR log is without being told.

## The four ideas

Most of the weight is carried by four rules. Each exists because of a specific failure:

**One fact, one home.** Cross-link instead of restating. Two copies of a fact do not stay in sync, and the second copy is where the wrongness lives.

**Closed debates become ADRs** — with what the decision rules out and what would justify revisiting it. Reasoning that lives in prose gets re-argued every month. An ADR that names its alternatives is enforceable in review; a paragraph of context is not.

**Assumptions carry what would falsify them.** "We assume users will pay $10" is a belief. "…falsified by cold conversion under 2%" is a testable claim with a trigger attached. If you cannot name what would disprove it, either it is a fact or it is untestable — and both of those belong somewhere else.

**No invented numbers.** A figure you do not have is an open question, not a plausible guess.

That last one is why this template ships **no example data at all**. Most documentation templates are full of realistic-looking placeholder metrics — `Active users: 10,000`, `Retention: 40%`. An agent reading that learns the expected output is realistic-looking metrics, and it will produce them. The failure is invisible: a placeholder number never errors, never logs, and reads exactly like a measurement forever.

## Table discipline

Every markdown table is tight-aligned — columns padded to the longest value, separator exactly that width, no trailing whitespace. **Never by hand:**

```bash
make docs-fmt    # rewrite in place
make docs-check  # exit 1 if anything is unaligned
make docs-links  # exit 1 if a relative link does not resolve
make check       # both — this is what CI runs
```

Alignment is not aesthetics. Hand-aligned tables produce diffs where every row changed because one cell got longer, which makes review of the actual change impossible. The script makes alignment deterministic, so a diff shows only what was edited.

**Tables are for short enumerable values only.** A cell needing a full sentence means the table should have been a bulleted list — prose-in-cells is unreadable in diffs and terminals, which is precisely where documentation gets read.

## Conventions

English everywhere in code, commits, PRs, and docs. Conventional Commits. Absolute dates — `2026-08-12`, never "last week", because a corpus is read months later by someone who does not know when it was written.

## Where this came from

Extracted from three production projects at [Cybrix](https://cybrix.cc) after the third copy of the same structure made it obvious what was common and what was project-specific. It is used, not theorised.

## License

MIT — see [LICENSE](LICENSE). Take it, fork it, change it.
