# Launch posts

Drafts for the first paid-product-adjacent traffic. Every figure here is
measured on the owner's own machine and dated; nothing is rounded up, and the
`caprock report` command regenerates all of it (Rule 6).

**Figures as of 2026-08-26**, 59 active days from 2026-05-24:

| Fact                        | Value                          |
| --------------------------- | ------------------------------ |
| Usage at API list prices    | $10,818                        |
| Paid over the same window   | $633.33 (a $200/month plan)    |
| Multiple                    | 17.1×                          |
| Turns · sessions · projects | 72,517 · 129 · 34              |
| Cache hit                   | 99%, cutting 89% of input cost |
| Largest spend category      | running commands — $5,450, 50% |
| Writing code                | $1,451, 13%                    |

The lead is the last two rows. "Half of what Claude Code costs me is running
commands, not writing code" is a finding; "I built a dashboard" is an
announcement, and announcements do not travel.

---

## Show HN

**Title** (80 chars max, no emoji, no exclamation):

```
Show HN: Caprock – local dashboard for Claude Code (Go, no server)
```

**Body:**

```
I run Claude Code most of the day and could not answer two questions about it:
what are these sessions doing right now, and what did they cost.

Caprock is one Go binary that reads the transcripts Claude Code already writes
plus a small hook shim, and serves a dashboard on 127.0.0.1:4173. Nothing
leaves the machine — no account, no server, no telemetry.

The thing I did not expect from my own data, 59 active days:

  running commands   $5,450   50%
  no tool call       $1,573   15%
  writing code       $1,451   13%
  MCP tools            $918    8%

Half the money goes to running commands. The part everyone pictures — writing
code — is an eighth of it. Cache hit is 99%, which cuts 89% of input cost, and
the same usage at API list prices is $10,818 against $633 of subscription over
that window. That figure is what the work would have cost through the API, not
a saving and not a bill.

It also detects loops (the same tool call repeating), shows cost per repo, and
has an opt-in runner that only marks a task done when the checks you named come
back green.

brew install dspv/tap/caprock, or scoop on Windows. Apache-2.0.
https://github.com/dspv/caprock
```

**Rules for the day it goes up:** post in the morning US time, then stay at the
keyboard for four hours and answer everything. An unanswered Show HN dies. Do
not upvote-beg anywhere, and do not post it to Reddit the same day — one
audience at a time, so a bad reception in one does not poison the other.

---

## Reddit — r/ClaudeAI

Findings-led, no link in the body. The link goes in a comment, once someone
asks or once the post has traction; a link in the body reads as an ad and gets
filtered by both moderators and readers.

**Title:**

```
I instrumented 59 days of Claude Code. Half the cost is running commands, not writing code.
```

**Body:**

```
I could not tell where my Claude Code money went, so I started capturing every
session locally — the transcripts it already writes, plus hooks for real-time
detail. 59 active days, 72,517 turns, 129 sessions across 34 repos.

Where it actually went:

  running commands   50%   ($5,450)
  no tool call       15%   ($1,573)
  writing code       13%   ($1,451)
  MCP tools           8%     ($918)
  reading/searching   7%     ($809)
  web research        2%     ($181)

Each turn counts toward one kind of work, decided by the tools it called. A
turn that called no tool is counted as exactly that rather than being
attributed to something flattering.

Two things surprised me. First, the shape: I assumed writing code was the
expensive part, and it is an eighth. The bill is dominated by the agent running
things — tests, builds, greps — and reading what came back. Second, the cache:
99% hit rate, cutting 89% of input cost. Without it none of this would be
affordable on a subscription.

Priced at Anthropic list rates, the usage comes to $10,818 against $633 of
subscription over the same window. That is what the same work would have cost
through the API — not money saved, since I would not have run this much
per-token.

Happy to answer how any of it is measured.
```

**If asked what tool:** answer plainly, name it, link it. Volunteering the link
before being asked is the difference between a finding and an advert.

---

## After either post

Watch `copy-command` in Umami rather than upvotes. The one measured conversion
we have is 17% of visitors copying the install command (2026-08-24, n=82) —
small sample, but it means traffic is the constraint, not the pitch.
