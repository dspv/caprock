# Content plan

Six weeks of posts, drawn from figures that already exist. Nothing here needs
new work to be true — every number comes from `caprock report` or the
dashboard, and running the command again is how a post gets refreshed rather
than rewritten.

## The rule that shapes every post

**Lead with the finding, never the product.** "Half of what Claude Code costs
me is running commands, not writing code" is a finding and it travels. "I built
a dashboard" is an announcement and it does not. The tool appears at the end,
as the answer to "how do you know that", which is the question a good finding
provokes.

The corollary: **a post needs a number nobody else has.** Opinions about agents
are infinite and free. A measurement is neither.

## Where each thing goes

| Surface           | Voice                | Language | Cadence             |
| ----------------- | -------------------- | -------- | ------------------- |
| caprock on X      | the product's        | English  | 2–3 a week          |
| caprock, LinkedIn | the product's        | English  | 1 a week            |
| caprock, YouTube  | screen only, no face | English  | 1 every 2 weeks     |
| Owner's Telegram  | his own              | Russian  | whenever he wants   |
| Reddit · HN       | his personal account | English  | once, then on merit |

Reddit and Hacker News are never posted from the product account. A brand
posting to r/ClaudeAI is an advertisement; a person posting a measurement is a
post. See [GTM-008](03-decisions.md).

**Buffer does not support Reddit.** It handles X, LinkedIn and YouTube, which
is most of this table — but the channel with the highest intent has to be
posted by hand, and by the owner, because it has to be answered by hand too.

## The findings, and what each one is worth

Ranked by how much of the argument each one carries on its own. Figures are
from the 2026-08-27 reading; re-run `caprock report` before publishing any of
them.

**1. Running commands is half the bill.** $5,455 of $11,442 — 48% — went on
turns whose most expensive act was running a command. Writing code was 13%.
Everyone assumes the model is expensive because it writes; it is expensive
because it runs what it wrote.

**2. Bash is 51% of every tool call.** 42,775 of 83,755. Reading is 14%,
editing 9%. The same finding as (1) from the other end, and it is the one that
makes engineers argue in the comments — which is what you want.

**3. The cache does more than the plan.** 99% hit rate, cutting 89% of what
input would otherwise cost. On a flat plan nobody sees this at all. This is the
finding that surprises people who thought they understood their own usage.

**4. A session can loop and nothing tells you.** The same tool call five times
in three minutes, unnoticed until someone went looking. This is the one that
makes people install rather than nod.

**5. Three months, $11,442 at list prices, $640 paid.** The headline. It
travels furthest and converts worst — it reads as a boast unless one of the
findings above is standing next to it.

**6. Two projects I would have called small were a third of the spend.** The
argument for measuring rather than estimating, and it works at any budget: the
person spending $300 a month has their own version of this.

## Six weeks

Each week is one finding, cut for each surface. The work is in the finding, not
in the writing — a finding cut three ways is one afternoon.

| Week | Finding                      | X                        | LinkedIn                 | YouTube            |
| ---- | ---------------------------- | ------------------------ | ------------------------ | ------------------ |
| 1    | Running commands is half     | the number, one chart    | what it means for a team | 60–90s, the screen |
| 2    | Bash is 51% of tool calls    | the tool distribution    | —                        | —                  |
| 3    | The cache does the work      | hit rate and what it cut | why flat plans hide it   | 60–90s, cache      |
| 4    | A session can loop           | the loop, unedited       | —                        | —                  |
| 5    | Small projects, big spend    | the per-project cut      | measuring vs estimating  | 60–90s, projects   |
| 6    | The headline, with a finding | $11,442 vs $640          | the whole receipt        | —                  |

Nothing is scheduled beyond week six on purpose: six weeks is enough to learn
whether any of this lands, and a plan longer than the evidence is a plan
written to feel productive.

## Video

**Screen only. No face, no surname** — the constraint the owner works under.

The first one is 60–90 seconds: the dashboard, his own figures, one finding
said out loud. Not a walkthrough, not a feature tour. A person who wants a tour
is already convinced; this is for the person who is not.

Recording is `make shots`' problem solved differently — the screen is real, the
database is real, and the same scrubbing applies: project names are renamed
before anything is recorded, because a video cannot be edited after it is
posted the way a screenshot can be replaced.

## What not to do

- **No posting cadence for its own sake.** A week with no finding is a week
  with no post. Filler is how a channel teaches people to scroll past it.
- **No claiming a saving.** Ever. The product refuses to and so does this.
- **No number that `caprock report` does not print.** Rule 6 applies to a
  tweet exactly as it applies to the dashboard.
- **No paid promotion yet** — [GTM-004](03-decisions.md) holds it until 15–20
  posts exist, and that has not changed.
